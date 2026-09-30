# PKV Belegbuch

Web-App fürs iPhone: Arztrechnungen scannen, archivieren und entscheiden, ob sich Einreichen lohnt oder der Gesundheitsbonus mehr bringt. Gerechnet wird mit den Bedingungen des Tarifs SIGNAL IDUNA KOMFORT-SI 1 (Selbstbehalt, Gesundheitsbonus 600/750/900 €, Vorsorge-Budget 750 €, Zahnstaffel).

- Daten liegen auf dem Gerät (IndexedDB). Im Code stehen keine persönlichen Daten.
- Sicherung in Google Drive (nur der eigene App-Ordner, Berechtigung `drive.file`): jede Rechnung als PDF, dazu ein Gesamt-Backup als JSON und wöchentliche Stände.
- Texterkennung (Tesseract.js) läuft lokal im Browser.

Installation: Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Google-Client-ID in der App unter „Mehr“ eintragen.
