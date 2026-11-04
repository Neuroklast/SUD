# SUD-Zeitleiste

Interaktive Zeitleiste für Alter 0 bis 37 und SUD-Werte 0 bis 10. Ereignisse, Notizen, Cluster, Datenimport und JSON-/CSV-/XLSX-/Offline-HTML-Export.

## Hosting

Deployment: Vercel, Framework Other, kein Build-Schritt, GitHub-Neudeploy bei Push auf `main`.

Die Anwendung verwendet ein einziges gemeinsam festgelegtes Passwort. Jeder, der dieses Passwort kennt, kann auf denselben Datenbestand zugreifen und ihn verändern. Eine Vercel-Anmeldung ist für Besucher nicht erforderlich.

Serverfunktionen:

- `api/auth.js`: Passwort-Ersteinrichtung über einen einmaligen, geheimen Einrichtungslink, Login, Passwortwechsel und Logout.
- `api/data.js`: Private Lese- und Schreibzugriffe mit signierter Sitzung, konfliktgeschützten ETags und serverseitiger AES-256-GCM-Verschlüsselung.
- `lib/auth.js`: PBKDF2-SHA256-Passworthash, 310000 Iterationen, zufälliges Salt. Sichere HttpOnly-Cookies mit HMAC-Signatur, `SameSite=Strict`, eine Woche Gültigkeit.
- `cloud.js`: Automatisches Laden, Speichern nach Änderungen und minimalistisches Passwortfenster.

Persistenz: **Vercel Blob (private)**. Keine Supabase-Datenbank, keine Cloud-Setup-Eingabefelder in der Oberfläche.

## Benötigte Vercel-Umgebungsvariablen

- `BLOB_READ_WRITE_TOKEN`: durch verbundene private Blob Storage erzeugt.
- `SUD_BOOTSTRAP_TOKEN`: zufälliges Einmaltoken für den Link zum anfänglichen Festlegen des Passworts.
- `SUD_SESSION_SECRET`: zufälliges HMAC-Secret zum Unterschreiben der Session-Cookies.
- `SUD_DATA_KEY`: zufälliger AES-Schlüssel, als Base64 kodiert (32 Byte).

Die Variablen gehören ausschließlich in die Vercel-Projekteinstellungen und niemals ins Repository. Nach erstmaliger Passworterstellung hat der Einrichtungslink keine Funktion mehr. Das Passwort selbst wird nicht im Klartext gespeichert.

## Datensicherung

Cloud-Daten werden serverseitig verschlüsselt im privaten Blob Store abgelegt. Lokale Browser-Kopien sowie exportierte JSON-, CSV-, XLSX- und HTML-Dateien sind nicht verschlüsselt. Sichere diese Dateien geschützt und exportiere bei Bedarf eine eigene Kopie.

Die Offline-HTML-Datei funktioniert ohne Vercel und ohne Passwortdialog. Sie enthält die Daten der aktuellen Momentaufnahme. Sie kann nichts in der Cloud verändern.

## Einschränkungen

Es handelt sich um eine gemeinsame Arbeitsmappe ohne getrennte Nutzerprofile. Alle mit dem Passwort sehen und bearbeiten denselben Datenbestand. Gleichzeitige Änderungen können einen ETag-Konflikt ergeben, der nicht automatisch überschrieben wird. Vor Wechseln zwischen Geräten sicherstellen, dass alle Änderungen gespeichert wurden.

Das Werkzeug dient der persönlichen Dokumentation. Die Belastungswerte sind subjektiv und keine klinische Diagnose.
