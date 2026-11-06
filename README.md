# SUD-Zeitleiste

Interaktive Zeitleiste für Alter 0 bis 37 und SUD-Werte 0 bis 10. Ereignisse, Notizen, Cluster, Datenimport und JSON-/CSV-/XLSX-/Offline-HTML-Export.

## Hosting

Deployment: Vercel, Framework Other, kein Build-Schritt, GitHub-Neudeploy bei Push auf `main`.

Die Anwendung verwendet ein einziges gemeinsam festgelegtes Passwort. Jeder, der dieses Passwort kennt, kann auf denselben Datenbestand zugreifen und ihn verändern. Eine Vercel-Anmeldung ist für Besucher nicht erforderlich.

Serverfunktionen:

- `api/auth.js`: Passwort-Ersteinrichtung über einen einmaligen, geheimen Einrichtungslink, Login, Passwortwechsel und Logout.
- `api/data.js`: Private Lese- und Schreibzugriffe mit signierter Sitzung, AES-256-GCM-Verschlüsselung sowie serverseitigem Zusammenführen paralleler Bearbeitungen und einem unveränderlichen Änderungsjournal ohne überschreibende Cloud-Writes.
- `lib/auth.js`: PBKDF2-SHA256-Passworthash, 310000 Iterationen, zufälliges Salt. Sichere HttpOnly-Cookies mit HMAC-Signatur, `SameSite=Strict`, eine Woche Gültigkeit.
- `cloud.js`: Automatisches Laden, Zusammenführen, Speichern und Abgleichen der Cloud-Daten mit anderen geöffneten Sitzungen.
- `sync-core.js`: Feldweises Zusammenführen gleichzeitig bearbeiteter Ereignisse und Cluster anhand ihrer IDs und der letzten gemeinsamen Version.

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

Es handelt sich um eine gemeinsame Arbeitsmappe ohne getrennte Nutzerprofile. Alle mit dem Passwort sehen und bearbeiten denselben Datenbestand. Bei geöffneter Anwendung wird die Cloud aktiv ungefähr alle 3 Sekunden abgeglichen, bei längerer Inaktivität seltener. Gleichzeitig bearbeitete unterschiedliche Ereignisse oder Felder werden serverseitig automatisch zusammengeführt. Werden exakt dieselben Felder gleichzeitig geändert, entscheidet die deterministische Reihenfolge der im Blob Store gespeicherten Änderungsdateien. Gleichzeitige Löschungen haben Vorrang vor älteren Bearbeitungen. Dies ist ein kurzintervalliger Abgleich und kein WebSocket-Push-System.

Bei Verbindungsproblemen werden Änderungen im Browser vorgemerkt und nach Wiederherstellung der Verbindung unter Berücksichtigung der letzten bestätigten Cloud-Version synchronisiert. Beim ersten Öffnen übernimmt die Cloud die Rolle als führender Datenbestand. Ein abweichender alter Browser-Datenbestand wird einmalig lokal unter dem Schlüssel `portable-sud-timeline-v1-pre-cloud-backup-v2` gesichert und nicht ungefragt über die Cloud geschrieben. Ist der Cloud-Datenbestand noch leer, können vorhandene lokale Daten als Anfangsbestand hochgeladen werden. Der gemeinsame Zugang bleibt über das bestehende Passwort geschützt.

Der Abgleich verwendet eine aus den unveränderlichen Änderungsdateien berechnete Datenversion. Unveränderte Daten müssen dabei nicht erneut vollständig heruntergeladen werden. Bei vielen dauerhaft geöffneten Sitzungen entstehen trotzdem regelmäßige Serverless-Aufrufe. Für echten Push-Betrieb mit sehr vielen Nutzern wäre ein separates Realtime-Backend sinnvoll.

Das Werkzeug dient der persönlichen Dokumentation. Die Belastungswerte sind subjektiv und keine klinische Diagnose.

## Gleichzeitige Bearbeitung und Fehlerbehandlung

Der Browser sendet Änderungen als `PATCH /api/data` mit der letzten lokal bestätigten Basisversion und dem aktuellen Datenstand. Der Server speichert jede Änderung verschlüsselt unter einem eindeutigen, inhaltsabhängigen Dateinamen in `sud/sync-v3/changes/`. Diese Dateien werden niemals überschrieben. Bei identischen erneut gesendeten Änderungen wird dieselbe Datei wiederverwendet. Gleichzeitige Schreibvorgänge können sich dadurch nicht mehr am ETag einer gemeinsamen Datei blockieren.

Beim ersten Zugriff wird der vorhandene verschlüsselte Datenbestand aus `sud/timeline-v2.json` einmalig als unveränderliche Basiskopie nach `sud/sync-v3/baseline.json` übertragen. Die ursprüngliche Datei wird nicht gelöscht oder verändert. Anschließend werden die aufgezeichneten Änderungen in nachvollziehbarer Reihenfolge feldweise zusammengeführt. Der gemeinsame Datenstand wird über `GET /api/data` abgerufen. Der bisherige direkte `PUT` wird mit HTTP 426 abgewiesen, damit veraltete Browserversionen keine Änderungen anderer Nutzer überschreiben.

Bei zeitweiligen Verbindungsstörungen bleiben Änderungen lokal gespeichert. Der Browser sendet sie nach Wiederherstellung der Verbindung erneut. Die einmalige Migration und die Wiederholung identischer Änderungen sind automatisch abgesichert. Für den Abgleich sind keine weiteren Umgebungsvariablen erforderlich.

**Betriebsgrenzen:** Das Journal benötigt bei zunehmender Zahl an Änderungen mehr Lesezugriffe und Speicherplatz. Vor mehr als 10.000 Änderungsdateien ist eine kontrollierte, verlustfreie Kompaktierung erforderlich. Das System nutzt weiterhin Polling und ist kein WebSocket-Push. Nach dem Deployment sollte jeder offene Browser-Tab einmal neu geladen werden. Ein Rollback auf die alte Ein-Datei-Version wäre ohne Übernahme des Journals nicht datenstandsgleich.

Tests: `node --test`. Die Tests decken insbesondere die einmalige Migration, gleichzeitig gespeicherte Änderungen, Wiederholungsanfragen und ETag-Abgleiche ab.
