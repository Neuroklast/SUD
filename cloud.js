/* Shared password access and automatic Vercel Blob sync.
   There are no user-managed cloud tokens or encryption passwords. */
(() => {
  'use strict';
  if (location.protocol === 'file:') return;

  const el = id => document.getElementById(id);
  const screen = el('auth-screen');
  const form = el('access-form');
  if (!screen || !form) return;

  const fragment = new URLSearchParams(location.hash.slice(1));
  const setupToken = fragment.get('setup');
  el('change-password').style.display = setupToken ? '' : 'none';
  if (setupToken) history.replaceState(null, '', location.pathname + location.search);

  let configured = false;
  let loggedIn = false;
  let ready = false;
  let etag = null;
  let dirty = false;
  let revision = 0;
  let writing = false;
  let autosaveTimer = null;
  let suppress = false;
  let changeMode = false;

  const status = (message, ok = true) => setStatus(message, ok);
  const show = (mode = 'login') => {
    changeMode = mode === 'change';
    screen.hidden = false;
    document.body.classList.add('locked');
    el('access-title').textContent = changeMode ? 'Passwort ändern' : configured ? 'SUD' : 'Passwort festlegen';
    el('access-submit').textContent = changeMode ? 'Ändern' : configured ? 'Öffnen' : 'Festlegen';
    el('access-cancel').hidden = !changeMode;
    el('access-password').value = '';
    el('access-message').textContent = '';
    el('access-password').focus();
  };
  const unlock = () => {
    loggedIn = true;
    screen.hidden = true;
    document.body.classList.remove('locked');
    el('access-password').value = '';
    status('Verbunden');
  };

  async function request(path, method = 'GET', payload = null) {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: payload === null ? {} : { 'Content-Type': 'application/json' },
      body: payload === null ? undefined : JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || 'Verbindung fehlgeschlagen (' + response.status + ')');
      error.status = response.status;
      if (response.status === 401 && path === '/api/data') {
        loggedIn = false;
        ready = false;
        show();
      }
      throw error;
    }
    return body;
  }

  const originalPersist = persist;
  persist = function () {
    originalPersist();
    if (suppress) return;
    dirty = true;
    revision++;
    if (loggedIn && ready) {
      status('Änderungen werden gespeichert …');
      queueSave();
    }
  };
  function queueSave() {
    if (!loggedIn || !ready) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(save, 900);
  }
  async function save() {
    if (writing || !ready || !loggedIn || !dirty) return;
    writing = true;
    const current = revision;
    try {
      const result = await request('/api/data', 'PUT', { data: normalize(data), etag });
      if (!result.etag) throw Error('Keine Datenversion zurückerhalten');
      etag = result.etag;
      dirty = current !== revision;
      status(dirty ? 'Weitere Änderungen werden gespeichert …' : 'Gespeichert');
    } catch (error) {
      if (error.status === 409) {
        ready = false;
        status('Speicherkonflikt. Lokale Daten bleiben erhalten.', false);
        alert('Die Daten wurden auf einem anderen Gerät geändert. Bitte deine lokalen Änderungen zuerst als JSON exportieren und dann neu laden.');
      } else {
        status('Cloud-Speicherung fehlgeschlagen. Lokale Daten sind vorhanden.', false);
      }
    } finally {
      writing = false;
      if (dirty && ready && loggedIn && current !== revision) queueSave();
    }
  }

  async function loadCloud() {
    ready = false;
    status('Lade Daten …');
    const remote = await request('/api/data');
    const hasLocal = data.events.length || data.clusters.length;
    if (remote.data) {
      const fromCloud = normalize(remote.data);
      const different = JSON.stringify(normalize(data)) !== JSON.stringify(fromCloud);
      if (hasLocal && different &&
          !confirm('Dieses Gerät enthält andere Einträge als die Cloud. Cloud-Version übernehmen? Abbrechen behält die lokalen Daten, ohne die Cloud zu überschreiben.')) {
        etag = remote.etag;
        status('Lokale Daten behalten. Cloud-Synchronisierung angehalten.', false);
        return;
      }
      suppress = true;
      try {
        data = fromCloud;
        selectedId = null;
        editorDraft = null;
        originalPersist();
        render();
      } finally { suppress = false; }
      etag = remote.etag;
      dirty = false;
      ready = true;
      status('Gespeichert');
    } else {
      etag = null;
      ready = true;
      if (hasLocal) {
        dirty = true;
        queueSave();
      } else {
        dirty = false;
        status('Bereit');
      }
    }
  }
  async function start() {
    try {
      const state = await request('/api/auth');
      configured = state.configured;
      if (state.authenticated) {
        unlock();
        await loadCloud();
      } else {
        show();
      }
    } catch (error) {
      show();
      el('access-message').textContent = error.message;
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const pass = el('access-password').value;
    if (pass.length < 12) {
      el('access-message').textContent = 'Mindestens 12 Zeichen erforderlich';
      return;
    }
    el('access-submit').disabled = true;
    el('access-message').textContent = '';
    try {
      await request('/api/auth', 'POST', changeMode
        ? { action: 'change', password: pass, setupToken }
        : configured ? { action: 'login', password: pass }
        : { action: 'setup', setupToken, password: pass });
      if (!changeMode) {
        configured = true;
        unlock();
        await loadCloud();
      } else {
        unlock();
        status('Passwort geändert');
      }
    } catch (error) {
      el('access-message').textContent = error.message;
      // Keep the error visible in the password form.
    } finally {
      el('access-submit').disabled = false;
      el('access-password').value = '';
    }
  });

  el('access-cancel').addEventListener('click', () => {
    screen.hidden = true;
    document.body.classList.remove('locked');
    changeMode = false;
  });
  el('change-password').addEventListener('click', () => show('change'));
  el('sign-out').addEventListener('click', async () => {
    await request('/api/auth', 'POST', { action: 'logout' }).catch(() => {});
    loggedIn = false;
    ready = false;
    configured = true;
    show();
  });
  el('save-cloud').addEventListener('click', async () => {
    if (!loggedIn) return show();
    if (!ready) {
      try { await loadCloud(); }
      catch (err) { status(err.message, false); }
      return;
    }
    dirty = true;
    await save();
  });
  window.addEventListener('beforeunload', e => {
    if (!dirty || !loggedIn || !ready) return;
    e.preventDefault();
    e.returnValue = '';
  });

  start();
})();
