/**
 * Haushaltsbuch – ING-Abruf über Enable Banking (Cloudflare Worker)
 *
 * Der Worker hält den privaten Schlüssel der Enable-Banking-Anwendung und reicht
 * nur lesende Kontoabfragen an die App weiter. Jede Anfrage muss ein gültiges
 * Google-Token der Haushaltsbuch-App mitbringen, dessen E-Mail-Adresse in
 * ALLOWED_EMAILS steht. Bankzugangsdaten sieht der Worker nie: Die Anmeldung
 * läuft direkt bei der ING.
 *
 * Variablen (Cloudflare → Worker → Settings → Variables and Secrets):
 *   EB_APP_ID         Anwendungs-ID aus dem Enable-Banking-Control-Panel (Text)
 *   EB_PRIVATE_KEY    Inhalt der .pem-Datei (Secret)
 *   ALLOWED_EMAILS    z. B. "rene@gmail.com,anika@gmail.com" (Text)
 *   GOOGLE_CLIENT_ID  OAuth-Client-ID der App (Text)
 *   ALLOWED_ORIGIN    https://rluetke-arch.github.io (Text)
 *   EB_COUNTRY        optional, Standard DE
 *   EB_BANK           optional, Standard ING
 */
const EB = 'https://api.enablebanking.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || '';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const reqOrigin = req.headers.get('Origin');
    if (reqOrigin && reqOrigin !== origin) return json({ error: 'Herkunft nicht erlaubt' }, 403);

    try {
      const u0 = new URL(req.url);
      if (u0.pathname.replace(/\/+$/, '') === '/callback' && req.method === 'GET') return callback(u0, env);
      const user = await checkGoogle(req, env);
      if (!user) return json({ error: 'Nicht berechtigt. Bitte in der App mit Google anmelden.' }, 401);
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/health' && req.method === 'GET') return json({ ok: true, email: user.email });

      if (path === '/auth' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        // Rücksprung immer zum Worker: Auf dem iPhone öffnet die ING-App den Rücksprung oft in Safari statt in der App.
        const redirect = url.origin + '/callback';
        const st = String(body.state || '');
        if (!UUID.test(st)) return json({ error: 'Ungültiger Status' }, 400);
        const aspsp = await findBank(env);
        const maxSec = Math.min(aspsp.maximum_consent_validity || 90 * 86400, 180 * 86400);
        const validUntil = new Date(Date.now() + (maxSec - 3600) * 1000).toISOString();
        const r = await eb(env, '/auth', { method: 'POST', body: {
          access: { valid_until: validUntil },
          aspsp: { name: aspsp.name, country: aspsp.country },
          state: st,
          redirect_url: redirect,
          psu_type: 'personal',
          language: 'de',
        } });
        return json({ url: r.url, bank: aspsp.name, valid_until: validUntil });
      }

      if (path === '/result' && req.method === 'GET') {
        const st = url.searchParams.get('state') || '';
        if (!UUID.test(st)) return json({ error: 'Ungültiger Status' }, 400);
        const cache = caches.default; const key = new Request('https://eb-result.internal/' + st);
        const hit = await cache.match(key);
        if (!hit) return json({ pending: true });
        const data = await hit.json(); await cache.delete(key);
        return json(data);
      }

      if (path === '/session' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const code = String(body.code || '');
        if (!code || code.length > 512) return json({ error: 'Code fehlt' }, 400);
        const s = await eb(env, '/sessions', { method: 'POST', body: { code } });
        return json({
          session_id: s.session_id,
          valid_until: s.access?.valid_until || null,
          bank: s.aspsp?.name || null,
          accounts: (s.accounts || []).map(a => ({ uid: a.uid, iban: a.account_id?.iban || null, name: a.name || a.product || null, product: a.product || null, currency: a.currency || null })),
        });
      }

      if (path === '/session' && req.method === 'DELETE') {
        const id = url.searchParams.get('id') || '';
        if (!UUID.test(id)) return json({ error: 'Ungültige Sitzung' }, 400);
        await eb(env, '/sessions/' + id, { method: 'DELETE' });
        return json({ ok: true });
      }

      if (path === '/transactions' && req.method === 'GET') {
        const acc = url.searchParams.get('account') || '';
        const from = url.searchParams.get('from') || '';
        const to = url.searchParams.get('to') || '';
        if (!UUID.test(acc)) return json({ error: 'Ungültiges Konto' }, 400);
        if (from && !DATE.test(from) || to && !DATE.test(to)) return json({ error: 'Ungültiges Datum' }, 400);
        const out = []; let key = null; let pages = 0;
        do {
          const q = new URLSearchParams({ transaction_status: 'BOOK' });
          if (from) q.set('date_from', from);
          if (to) q.set('date_to', to);
          if (key) q.set('continuation_key', key);
          const r = await eb(env, `/accounts/${acc}/transactions?${q}`);
          out.push(...(r.transactions || []));
          key = r.continuation_key || null; pages++;
        } while (key && pages < 30);
        return json({ transactions: out });
      }

      if (path === '/balances' && req.method === 'GET') {
        const acc = url.searchParams.get('account') || '';
        if (!UUID.test(acc)) return json({ error: 'Ungültiges Konto' }, 400);
        const r = await eb(env, `/accounts/${acc}/balances`);
        return json({ balances: r.balances || [] });
      }

      return json({ error: 'Nicht gefunden' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e), status: e.status || 500 }, e.status && e.status < 500 ? e.status : 502);
    }
  },
};

/* ---------- Google-Anmeldung prüfen ---------- */
const tokenCache = new Map();
async function checkGoogle(req, env) {
  const h = req.headers.get('Authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok || tok.length > 4096) return null;
  const c = tokenCache.get(tok);
  if (c && c.exp > Date.now()) return c;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(tok));
  if (!r.ok) return null;
  const info = await r.json();
  const normMail = m => String(m || '').trim().toLowerCase().replace(/@googlemail\.com$/, '@gmail.com');
  const allowed = String(env.ALLOWED_EMAILS || '').split(',').map(normMail).filter(Boolean);
  const email = normMail(info.email);
  const okClient = !env.GOOGLE_CLIENT_ID || info.azp === env.GOOGLE_CLIENT_ID || info.aud === env.GOOGLE_CLIENT_ID;
  const okMail = allowed.length > 0 && String(info.email_verified) === 'true' && allowed.includes(email);
  if (!okClient || !okMail) return null;
  const user = { email, exp: Math.min(Date.now() + 10 * 60 * 1000, (+info.exp || 0) * 1000) };
  if (tokenCache.size > 50) tokenCache.clear();
  tokenCache.set(tok, user);
  return user;
}

/* ---------- Enable Banking ---------- */
let bankCache = null;
async function findBank(env) {
  if (bankCache && bankCache.t > Date.now() - 6 * 3600 * 1000) return bankCache.a;
  const country = env.EB_COUNTRY || 'DE';
  const want = (env.EB_BANK || 'ING').toLowerCase();
  const r = await eb(env, `/aspsps?country=${country}`);
  const list = r.aspsps || [];
  const a = list.find(x => x.name.toLowerCase() === want)
    || list.find(x => x.name.toLowerCase().startsWith(want + ' ') || x.name.toLowerCase().startsWith(want + '-'))
    || list.find(x => x.name.toLowerCase().includes(want));
  if (!a) { const e = new Error(`Bank „${env.EB_BANK || 'ING'}“ in ${country} nicht gefunden`); e.status = 404; throw e; }
  bankCache = { t: Date.now(), a };
  return a;
}

async function eb(env, path, { method = 'GET', body } = {}) {
  const jwt = await makeJwt(env);
  const r = await fetch(EB + path, {
    method,
    headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text.slice(0, 200) }; }
  if (!r.ok) {
    const msg = data?.message || data?.error || data?.detail || ('HTTP ' + r.status);
    const e = new Error('Enable Banking: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
    e.status = r.status === 401 || r.status === 403 ? 502 : r.status; throw e;
  }
  return data;
}

/* ---------- JWT (RS256) ---------- */
let keyCache = null;
async function makeJwt(env) {
  if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) throw new Error('EB_APP_ID oder EB_PRIVATE_KEY fehlt im Worker');
  if (!keyCache) keyCache = await importKey(env.EB_PRIVATE_KEY);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: env.EB_APP_ID }));
  const claims = b64url(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 }));
  const data = new TextEncoder().encode(head + '.' + claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyCache, data);
  return head + '.' + claims + '.' + b64url(new Uint8Array(sig));
}
function b64url(x) {
  const bytes = typeof x === 'string' ? new TextEncoder().encode(x) : x;
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function importKey(pem) {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  let der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (isPkcs1) der = pkcs1to8(der);
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
function derLen(n) { if (n < 128) return [n]; const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return [0x80 | b.length, ...b]; }
function der(tag, content) { return [tag, ...derLen(content.length), ...content]; }
function pkcs1to8(pkcs1) {
  const algo = der(0x30, [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return new Uint8Array(der(0x30, [0x02, 0x01, 0x00, ...algo, ...der(0x04, [...pkcs1])]));
}

/* ---------- Rücksprung von der Bank ---------- */
async function callback(url, env) {
  const st = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const err = url.searchParams.get('error');
  let ok = false, msg = '';
  if (UUID.test(st)) {
    let data;
    if (code && !err) {
      try {
        const s = await eb(env, '/sessions', { method: 'POST', body: { code } });
        data = { session_id: s.session_id, valid_until: s.access?.valid_until || null, bank: s.aspsp?.name || null,
          accounts: (s.accounts || []).map(a => ({ uid: a.uid, iban: a.account_id?.iban || null, name: a.name || a.product || null, product: a.product || null, currency: a.currency || null })) };
        ok = true;
      } catch (e) { data = { error: e.message }; msg = e.message; }
    } else { data = { error: url.searchParams.get('error_description') || err || 'abgebrochen' }; msg = data.error; }
    await caches.default.put(new Request('https://eb-result.internal/' + st), new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=900' } }));
  } else msg = 'Ungültiger Aufruf';
  const app = (env.ALLOWED_ORIGIN || '') + '/PKV/haushalt/';
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Haushaltsbuch</title>
<style>:root{color-scheme:light dark}body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:Canvas;color:CanvasText}h1{font-size:1.4rem}a.b{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#3b82f6;color:#fff;text-decoration:none;font-weight:600}p.s{opacity:.7;font-size:15px}</style></head><body>
<h1>${ok ? 'ING ist verbunden ✓' : 'Verbindung nicht abgeschlossen'}</h1>
<p>${ok ? 'Wechsle jetzt zurück in die Haushaltsbuch-App auf deinem Home-Bildschirm. Sie übernimmt die Verbindung automatisch.' : esc(msg || 'Bitte in der App noch einmal „Mit ING verbinden“ tippen.')}</p>
<a class="b" href="${esc(app)}">Zurück zum Haushaltsbuch</a>
<p class="s">Falls sich dabei Safari statt der App öffnet: Safari schließen und die App über das Symbol auf dem Home-Bildschirm öffnen.</p></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
