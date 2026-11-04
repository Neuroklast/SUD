/* Client-side encryption and private Vercel Blob sync.
   Never send a plaintext event, cluster or encryption password to an API. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const section = el('cloud-section');
  if (!section || location.protocol === 'file:') return;
  section.hidden = false;
  section.style.display = 'block';

  let accessKey = '';
  let passphrase = '';
  let etag = null;
  let cloudLoaded = false;
  let dirty = false;
  let busy = false;
  let revision = 0;
  let timer = null;
  let suppressDirty = false;

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const toBase64 = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 16384) {
      s += String.fromCharCode(...bytes.subarray(i, i + 16384));
    }
    return btoa(s);
  };
  const fromBase64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

  const status = (message, problem = false) => {
    const node = el('cloud-status');
    node.textContent = message;
    node.style.color = problem ? '#ffb2aa' : '#b6dbcc';
  };
  const rememberCredentials = () => {
    if (el('cloud-access').value.trim()) {
      accessKey = el('cloud-access').value.trim();
      // Secrets are session-memory-only; never written into localStorage or a file.
      el('cloud-access').value = '';
    }
    if (el('cloud-pass').value) {
      passphrase = el('cloud-pass').value;
      el('cloud-pass').value = '';
    }
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(accessKey)) {
      throw Error('Bitte einen gültigen Cloud-Zugangsschlüssel eintragen.');
    }
    if (passphrase.length < 12) {
      throw Error('Bitte ein separates Verschlüsselungspasswort mit mindestens 12 Zeichen eingeben.');
    }
  };
  const derive = async (secret, salt) => {
    const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  };
  const encrypt = async plain => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await derive(passphrase, salt);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode('SUD-V1') }, key, enc.encode(plain)
    ));
    return { format: 'sud-aes-gcm-v1', salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
  };
  const decrypt = async envelope => {
    if (!envelope || envelope.format !== 'sud-aes-gcm-v1') throw Error('Unbekanntes Cloud-Format');
    const salt = fromBase64(envelope.salt);
    const iv = fromBase64(envelope.iv);
    if (salt.length !== 16 || iv.length !== 12) throw Error('Ungültiges Verschlüsselungsformat');
    const key = await derive(passphrase, salt);
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode('SUD-V1') }, key,
        fromBase64(envelope.ciphertext)
      );
      return dec.decode(plaintext);
    } catch {
      throw Error('Entschlüsselung fehlgeschlagen. Ist das Verschlüsselungspasswort korrekt?');
    }
  };
  const request = async (method, payload) => {
    const response = await fetch('/api/data', {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + accessKey, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined
    });
    let result = {};
    try { result = await response.json(); } catch { /* non-JSON gateway error */ }
    if (!response.ok) {
      const err = new Error(result.error || ('Cloud-Fehler HTTP ' + response.status));
      err.status = response.status;
      throw err;
    }
    return result;
  };
  const run = async job => {
    if (busy) return;
    busy = true;
    el('cloud-load').disabled = el('cloud-save').disabled = true;
    try { await job(); }
    catch (err) {
      status(err?.message || 'Cloud-Aktion fehlgeschlagen', true);
    } finally {
      busy = false;
      el('cloud-load').disabled = el('cloud-save').disabled = false;
    }
  };

  const localChanged = persist;
  persist = function () {
    localChanged();
    if (suppressDirty) return;
    dirty = true;
    revision++;
    if (cloudLoaded) {
      status('Lokal geändert. Noch nicht in der Cloud gespeichert.');
      if (el('cloud-auto').checked) schedule();
    }
  };

  async function loadCloud() {
    rememberCredentials();
    status('Lade verschlüsselten Datensatz …');
    const remote = await request('GET');
    if (!remote.data) {
      cloudLoaded = true;
      etag = null;
      dirty = Boolean(data.events.length || data.clusters.length);
      status('Cloud ist leer. Du kannst deine aktuellen lokalen Daten jetzt speichern.');
      return;
    }
    const decoded = normalize(JSON.parse(await decrypt(remote.data)));
    if ((data.events.length || data.clusters.length) &&
        JSON.stringify(data) !== JSON.stringify(decoded) &&
        !confirm('Die Cloud enthält andere Daten als dieses Gerät. Soll die lokale Ansicht durch die Cloud-Version ersetzt werden? Vorher bei Bedarf JSON exportieren.')) {
      status('Cloud-Version wurde nicht übernommen. Lokale Daten sind unverändert.', true);
      return;
    }
    suppressDirty = true;
    try {
      data = decoded;
      selectedId = null;
      editorDraft = null;
      persist();
      render();
    } finally { suppressDirty = false; }
    etag = remote.etag;
    cloudLoaded = true;
    dirty = false;
    status('Cloud-Daten entschlüsselt und geladen. Die lokale Kopie ist aktuell.');
  }

  async function saveCloud() {
    rememberCredentials();
    if (!cloudLoaded) {
      const remote = await request('GET');
      if (remote.data) {
        throw Error('In der Cloud sind bereits Daten. Bitte zuerst „Aus Cloud laden“ wählen. Deine lokalen Daten wurden nicht überschrieben.');
      }
      cloudLoaded = true;
      etag = null;
    }
    const atRevision = revision;
    const serialized = JSON.stringify(normalize(data));
    status('Verschlüssele und speichere …');
    const envelope = await encrypt(serialized);
    const saved = await request('PUT', { data: envelope, etag });
    etag = saved.etag;
    if (!etag) {
      cloudLoaded = false;
      dirty = true;
      throw Error('Gespeichert, aber keine Versionskennung erhalten. Vor dem nächsten Speichern bitte Cloud neu laden.');
    }
    dirty = atRevision !== revision;
    status(dirty ? 'Cloud gesichert. Neue lokale Änderungen warten noch.' : 'Cloud-Sicherung erfolgreich. Alles synchron.');
    if (dirty && el('cloud-auto').checked) schedule();
  }

  function schedule() {
    if (!cloudLoaded || !dirty || !el('cloud-auto').checked) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (busy) { schedule(); return; }
      run(saveCloud);
    }, 1700);
  }

  el('cloud-load').addEventListener('click', () => run(loadCloud));
  el('cloud-save').addEventListener('click', () => run(saveCloud));
  el('cloud-auto').addEventListener('change', () => {
    if (el('cloud-auto').checked) {
      if (!cloudLoaded) status('Für automatische Sicherungen zuerst die Cloud laden oder erstmalig speichern.');
      else schedule();
    }
  });
  window.addEventListener('beforeunload', event => {
    if (!dirty || !cloudLoaded) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();