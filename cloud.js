/* Authenticated collaborative synchronization on encrypted private Vercel Blob.
   Cloud is canonical. Cached changes are merged using optimistic ETags. */
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

  const sync = window.SUDSync;
  if (!sync) {
    setStatus('Synchronisierungsmodul fehlt. Bitte neu laden.', false);
    return;
  }

  const BASE_KEY = STORAGE_KEY + '-cloud-base-v2';
  const PENDING_KEY = STORAGE_KEY + '-pending-v2';
  const BACKUP_KEY = STORAGE_KEY + '-pre-cloud-backup-v2';
  const DELETIONS_KEY = STORAGE_KEY + '-explicit-deletions-v1';
  const empty = () => ({ version: 1, events: [], clusters: [] });
  const snapshot = value => normalize(JSON.parse(JSON.stringify(value)));
  const status = (message, ok = true) => setStatus(message, ok);

  let configured = false;
  let loggedIn = false;
  let ready = false;
  let etag = null;
  let baseSnapshot = null;
  let dirty = false;
  let revision = 0;
  let writing = false;
  let refreshing = false;
  let autosaveTimer = null;
  let pollTimer = null;
  let suppress = false;
  let changeMode = false;
  let lastActivity = Date.now();
  let lastConflictCount = 0;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('sud-cloud-refresh-v2') : null;
  function parseDeletes(value) {
    return {
      events: Array.isArray(value?.events) ? [...new Set(value.events.filter(id => typeof id === 'string'))] : [],
      clusters: Array.isArray(value?.clusters) ? [...new Set(value.clusters.filter(id => typeof id === 'string'))] : []
    };
  }
  let pendingDeletes = { events: [], clusters: [] };
  try { pendingDeletes = parseDeletes(JSON.parse(localStorage.getItem(DELETIONS_KEY) || '{}')); }
  catch (_) { /* No locally queued deletions yet. */ }

  // Only user-confirmed deletion actions create tombstones. Missing records in
  // old browser snapshots must never be treated as delete instructions.
  window.SUDRecordDeletion = (type, id) => {
    const key = type === 'event' ? 'events' : type === 'cluster' ? 'clusters' : null;
    if (!key || typeof id !== 'string' || !id) return;
    if (!pendingDeletes[key].includes(id)) pendingDeletes[key].push(id);
    try { localStorage.setItem(DELETIONS_KEY, JSON.stringify(pendingDeletes)); }
    catch (_) { status('Löschung lokal nicht gesichert. Bitte JSON exportieren.', false); }
  };
  function combinedDeletes(remote) {
    const server = parseDeletes(remote);
    return {
      events: [...new Set([...server.events, ...pendingDeletes.events])],
      clusters: [...new Set([...server.clusters, ...pendingDeletes.clusters])]
    };
  }
  function excludeDeleted(source, deleted) {
    const del = combinedDeletes(deleted);
    const events = new Set(del.events);
    const clusters = new Set(del.clusters);
    return {
      version: 1,
      events: source.events.filter(entry => !events.has(entry.id)).map(entry => ({
        ...entry, clusterIds: entry.clusterIds.filter(id => !clusters.has(id))
      })),
      clusters: source.clusters.filter(cluster => !clusters.has(cluster.id))
    };
  }
  // If the server returns an incomplete snapshot, keep locally present records.
  // Only explicit confirmed tombstones are permitted to remove an ID.
  function preserveMissing(local, remote, deleted) {
    const foundEvents = new Set(remote.events.map(entry => entry.id));
    const foundClusters = new Set(remote.clusters.map(cluster => cluster.id));
    const filtered = {
      version: 1,
      events: [...remote.events, ...local.events.filter(entry => !foundEvents.has(entry.id))],
      clusters: [...remote.clusters, ...local.clusters.filter(cluster => !foundClusters.has(cluster.id))]
    };
    return normalize(excludeDeleted(filtered, deleted));
  }
  function storePendingDeletes() {
    try {
      if (pendingDeletes.events.length || pendingDeletes.clusters.length) {
        localStorage.setItem(DELETIONS_KEY, JSON.stringify(pendingDeletes));
      } else localStorage.removeItem(DELETIONS_KEY);
    } catch (_) { status('Ausstehende Löschungen konnten nicht lokal gesichert werden.', false); }
  }


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
    status('Verbinde mit der Cloud …');
  };

  async function request(path, method = 'GET', payload = null, knownEtag = null) {
    const headers = {};
    if (payload !== null) headers['Content-Type'] = 'application/json';
    if (method === 'GET' && knownEtag) headers['If-None-Match'] = knownEtag;
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      body: payload === null ? undefined : JSON.stringify(payload)
    });
    if (response.status === 304) return { unchanged: true, etag: knownEtag };
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || 'Verbindung fehlgeschlagen (' + response.status + ')');
      error.status = response.status;
      error.code = body.code || null;
      error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
      if (response.status === 401 && path === '/api/data') {
        loggedIn = false;
        ready = false;
        clearTimeout(autosaveTimer);
        clearTimeout(pollTimer);
        show();
      }
      throw error;
    }
    return body;
  }

  const originalPersist = persist;
  function storeSyncState() {
    try {
      if (baseSnapshot) localStorage.setItem(BASE_KEY, JSON.stringify(baseSnapshot));
      if (dirty) localStorage.setItem(PENDING_KEY, '1');
      else localStorage.removeItem(PENDING_KEY);
    } catch (error) {
      status('Lokale Sicherung nicht möglich. Bitte JSON exportieren.', false);
    }
  }
  function keepLegacyBackup(local) {
    try {
      if (!localStorage.getItem(BACKUP_KEY)) localStorage.setItem(BACKUP_KEY, JSON.stringify(local));
    } catch (_) { /* Browser storage may be disabled. */ }
  }

  persist = function () {
    originalPersist();
    if (suppress) return;
    revision++;
    dirty = true;
    storeSyncState();
    if (loggedIn && ready) {
      status('Änderungen werden synchronisiert …');
      queueSave();
    } else {
      status('Lokal gespeichert. Verbindung zur Cloud ausstehend.', false);
    }
  };

  function queueSave(delay = 650) {
    if (!loggedIn || !ready || !dirty) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(save, delay);
  }

  // Remote updates never replace an unfinished event form.
  function applyDocument(next, preserveDraft) {
    const oldEvent = selectedId ? data.events.find(item => item.id === selectedId) : editorDraft;
    const formValues = preserveDraft && typeof readEditorFields === 'function' ? readEditorFields() : null;
    const focused = document.activeElement?.id;
    data = next;
    if (selectedId && !data.events.some(item => item.id === selectedId)) {
      selectedId = null;
      editorDraft = null;
    }
    suppress = true;
    try {
      originalPersist();
      render();
    } finally {
      suppress = false;
    }
    if (formValues && !el('event-form').hidden && (!formValues.id || formValues.id === selectedId)) {
      const changed = key => !oldEvent || !sync.equal(formValues[key], oldEvent[key]);
      if (changed('title')) el('event-title').value = formValues.title;
      if (changed('age')) el('event-age').value = String(formValues.age);
      if (changed('sud')) el('event-sud').value = String(formValues.sud);
      if (changed('notes')) el('event-notes').value = formValues.notes;
      if (changed('clusterIds')) {
        const chosen = new Set(formValues.clusterIds);
        for (const input of el('event-cluster-checks').querySelectorAll('input')) {
          input.checked = chosen.has(input.value);
        }
      }
    }
    if (focused && el(focused) && document.activeElement?.id !== focused && !el(focused).hidden) {
      el(focused).focus({ preventScroll: true });
    }
  }

  // API merges against the latest confirmed cloud snapshot and handles CAS
  // conflicts internally. One browser PATCH replaces the old PUT/409 storm.
  let retryDelay = 3000;
  async function save() {
    if (writing || refreshing || !ready || !loggedIn || !dirty) return;
    writing = true;
    clearTimeout(autosaveTimer);
    const startRevision = revision;
    const startDocument = snapshot(data);
    const originalBase = snapshot(baseSnapshot || empty());
    const sentDeletes = parseDeletes(pendingDeletes);
    let failed = false;
    try {
      const result = await request('/api/data', 'PATCH', {
        base: originalBase,
        data: startDocument,
        deletions: sentDeletes
      });
      if (result.etag === undefined || !result.data) throw Error('Server hat keine bestätigte Datenversion zurückgegeben');
      const stored = snapshot(result.data);
      const serverDeleted = parseDeletes(result.deleted);
      for (const key of ['events', 'clusters']) {
        if (sentDeletes[key].some(id => !serverDeleted[key].includes(id))) {
          throw Error('Löschung wurde vom Server nicht bestätigt');
        }
      }
      // A confirmed tombstone is the only permitted reason for losing a record.
      for (const key of ['events', 'clusters']) {
        pendingDeletes[key] = pendingDeletes[key].filter(id => !sentDeletes[key].includes(id));
      }
      storePendingDeletes();
      etag = result.etag;
      baseSnapshot = stored;
      const current = snapshot(data);
      const merged = revision === startRevision ? stored :
        snapshot(sync.mergeData(startDocument, current, stored).data);
      const restored = preserveMissing(current, merged, serverDeleted);
      applyDocument(restored, true);
      dirty = !sync.equal(restored, stored) ||
        pendingDeletes.events.length > 0 || pendingDeletes.clusters.length > 0;
      storeSyncState();
      retryDelay = 3000;
      status(dirty ? 'Unvollständige Cloud-Antwort erkannt. Daten werden erneut abgeglichen …' :
        result.conflictCount
          ? 'Synchronisiert. ' + result.conflictCount + ' gleichzeitig bearbeitete Felder zusammengeführt.'
          : 'Cloud synchronisiert', !dirty);
      channel?.postMessage({ type: 'updated' });
    } catch (error) {
      if (error.status === 401) return;
      failed = true;
      dirty = true;
      storeSyncState();
      if (error.code === 'BLOB_CAS_INCONSISTENT') {
        status('Cloud lehnt aktuelle Dateiversion ab. Änderungen sind lokal gesichert.', false);
        retryDelay = Math.max(retryDelay, 30000);
      } else {
        status(error.message || 'Cloud-Speicherung ausstehend. Erneuter Versuch folgt.', false);
      }
      if (error.retryAfter) retryDelay = Math.max(retryDelay, error.retryAfter * 1000);
    } finally {
      writing = false;
      if (dirty && ready && loggedIn && navigator.onLine) {
        queueSave(failed ? retryDelay : 900);
        if (failed) retryDelay = Math.min(retryDelay * 2, 60000);
      }
    }
  }

  async function loadCloud() {
    ready = false;
    status('Lade gemeinsamen Datenbestand …');
    const remote = await request('/api/data');
    const cloud = normalize(remote.data || empty());
    const local = snapshot(data);
    let previouslySynced = null;
    let pending = dirty;
    try {
      const raw = localStorage.getItem(BASE_KEY);
      if (raw) previouslySynced = normalize(JSON.parse(raw));
      pending = pending || localStorage.getItem(PENDING_KEY) === '1';
    } catch (_) { /* Continue from the cloud copy. */ }

    if (!sync.equal(local, cloud) && (local.events.length || local.clusters.length)) {
      keepLegacyBackup(local);
    }
    const base = previouslySynced || empty();
    const merged = sync.mergeData(base, local, cloud);
    lastConflictCount += merged.conflicts.length;
    const next = preserveMissing(local, normalize(merged.data), remote.deleted);

    etag = remote.etag;
    baseSnapshot = snapshot(cloud);
    applyDocument(next, false);
    dirty = !sync.equal(next, cloud) || pendingDeletes.events.length > 0 ||
      pendingDeletes.clusters.length > 0;
    ready = true;
    storeSyncState();
    if (dirty) queueSave();
    else status('Cloud synchronisiert');
    schedulePoll();
  }

  async function refreshCloud() {
    if (!loggedIn || !ready || refreshing || writing || !navigator.onLine) return;
    refreshing = true;
    try {
      const remote = await request('/api/data', 'GET', null, etag);
      if (remote.unchanged) return;
      const cloud = normalize(remote.data || empty());
      const current = snapshot(data);
      const merged = dirty
        ? sync.mergeData(baseSnapshot || empty(), current, cloud)
        : { data: cloud, conflicts: [] };
      lastConflictCount += merged.conflicts.length;
      const next = preserveMissing(current, normalize(merged.data), remote.deleted);
      etag = remote.etag;
      baseSnapshot = snapshot(cloud);
      applyDocument(next, true);
      dirty = !sync.equal(next, cloud) || pendingDeletes.events.length > 0 ||
        pendingDeletes.clusters.length > 0;
      storeSyncState();
      if (dirty) queueSave();
      else status('Cloud synchronisiert');
    } catch (error) {
      if (error.status !== 401) status('Verbindung unterbrochen. Daten werden erneut abgeglichen.', false);
    } finally {
      refreshing = false;
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!loggedIn || !ready) return;
    const delay = document.visibilityState === 'hidden' ? 60000 :
      Date.now() - lastActivity < 90000 ? 3000 : 12000;
    pollTimer = setTimeout(async () => {
      await refreshCloud();
      schedulePoll();
    }, delay);
  }

  document.addEventListener('pointerdown', () => { lastActivity = Date.now(); }, { passive: true });
  document.addEventListener('keydown', () => { lastActivity = Date.now(); }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastActivity = Date.now();
      refreshCloud();
    }
    schedulePoll();
  });
  window.addEventListener('focus', () => { lastActivity = Date.now(); refreshCloud(); });
  window.addEventListener('online', () => { refreshCloud(); if (dirty) queueSave(); });
  channel?.addEventListener('message', event => {
    if (event.data?.type === 'updated') refreshCloud();
  });

  async function start() {
    try {
      const state = await request('/api/auth');
      configured = state.configured;
      if (state.authenticated) {
        unlock();
        await loadCloud();
      } else show();
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
    clearTimeout(pollTimer);
    clearTimeout(autosaveTimer);
    show();
  });
  el('save-cloud').addEventListener('click', async () => {
    if (!loggedIn) return show();
    if (!ready) {
      try { await loadCloud(); }
      catch (err) { status(err.message, false); }
      return;
    }
    if (!dirty) {
      await refreshCloud();
      return;
    }
    await save();
  });
  window.addEventListener('beforeunload', event => {
    if (!dirty || !loggedIn) return;
    event.preventDefault();
    event.returnValue = '';
  });

  start();
})();
