# Bank-Dienst für das Haushaltsbuch (ING über Enable Banking)

Kleiner Cloudflare Worker, der den privaten Schlüssel der Enable-Banking-Anwendung hält und nur **lesende** Kontoabfragen an die App weiterreicht.

Sicherheit:
- Der Schlüssel liegt nur als Secret im Worker, nie in der App oder im Repository.
- Jede Anfrage braucht ein gültiges Google-Token der Haushaltsbuch-App; die E-Mail muss in `ALLOWED_EMAILS` stehen.
- Anfragen werden nur von `ALLOWED_ORIGIN` (der App-Adresse) angenommen.
- Die Anmeldung bei der Bank läuft direkt bei der ING; der Worker sieht keine Zugangsdaten.
- Zugriff nur lesend (Konto-Informationen), höchstens 180 Tage, jederzeit in der App oder bei der ING widerrufbar.

Variablen (Worker → Settings → Variables and Secrets):

| Name | Typ | Wert |
|---|---|---|
| `EB_APP_ID` | Text | Anwendungs-ID (Dateiname der .pem ohne Endung) |
| `EB_PRIVATE_KEY` | Secret | kompletter Inhalt der .pem-Datei |
| `ALLOWED_EMAILS` | Text | Gmail-Adressen, mit Komma getrennt |
| `GOOGLE_CLIENT_ID` | Text | OAuth-Client-ID der App |
| `ALLOWED_ORIGIN` | Text | `https://rluetke-arch.github.io` |

Endpunkte: `GET /health`, `POST /auth`, `POST /session`, `DELETE /session?id=`, `GET /transactions?account=&from=`, `GET /balances?account=`.
