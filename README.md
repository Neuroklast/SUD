# SUD-Zeitleiste

Portierbare deutschsprachige SUD-Zeitleiste (Alter 0–37, Belastung 0–10) mit Ereignissen, Notizen, Clustern und JSON-, CSV-, HTML- sowie XLSX-Export.

## Vercel-Setup

Dieses Repository ist direkt auf Vercel deploybar (Framework: Other, kein Build-Schritt).

1. Einen **privaten** Vercel Blob Store mit dem Projekt verbinden. Vercel setzt dabei die Umgebungsvariable BLOB_READ_WRITE_TOKEN.
2. Einen zufälligen Zugangsschlüssel (mindestens 40 Zeichen) als SUD_ACCESS_TOKEN in den Vercel-Umgebungsvariablen hinterlegen.
3. Erneut deployen, um beide Variablen für die Funktionen zu aktivieren.
4. Vercel Authentication für die Webseite eingeschaltet lassen.
5. Auf der Webseite den Cloud-Zugangsschlüssel und ein eigenes, anderes Verschlüsselungspasswort (mindestens 12 Zeichen) eingeben.
6. Bei leerer Cloud erstmals speichern. Auf weiteren Geräten zuerst aus der Cloud laden. Automatische Synchronisierung ist optional.

Die Verschlüsselung geschieht nur im Browser mit AES-256-GCM. Der Schlüssel wird per PBKDF2/SHA-256, 310.000 Iterationen und zufälligem Salt aus dem Verschlüsselungspasswort abgeleitet. Vercel erhält nur verschlüsselte Daten. Das Verschlüsselungspasswort wird nie an die API gesendet.

Vercel Blob ist privat, die API authentifiziert jede Anfrage zusätzlich mit einem Zugangsschlüssel und verwendet ETags für konfliktgeschütztes Speichern. Bei parallelen Bearbeitungen wird nicht stillschweigend überschrieben.

## Lokale Nutzung

Ohne Cloud funktioniert die HTML-Anwendung weiter, auch offline. Daten werden im lokalen Browser-Speicher gespeichert. Exportierte HTML-, JSON-, CSV- und Excel-Dateien sowie der lokale Browser-Speicher sind **unverschlüsselt**. Sichere diese Dateien passend zu ihrem vertraulichen Inhalt.

JSON- und Excel-Dateien lassen sich wieder importieren. Der HTML-Export mit Daten erzeugt eine einzelne eigenständig ausführbare Datei.

Das Verschlüsselungspasswort ist nicht wiederherstellbar. Daher zusätzlich ein geschütztes lokales Backup aufbewahren.

## Prüfung

Nach dem Deployment Punkte mit SUD 0 und 10 erstellen, Cluster zuordnen, JSON/XLSX exportieren und wieder importieren, Cloud speichern und in einem zweiten Browser aus der Cloud laden. Bei einem veralteten Stand soll die Cloud einen Konflikt melden.

Das Werkzeug dient der persönlichen Dokumentation, nicht der Diagnostik. Die Anwendung sollte vor produktivem Einsatz mit sensiblen Informationen zusätzlich an der realen Konfiguration geprüft werden.
