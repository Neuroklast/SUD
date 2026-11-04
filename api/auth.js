import {
  json, rejectCrossOrigin, passwordValid, safeEqual, readPasswordRecord, checkPassword,
  initialSetup, updatePassword, createSession, clearSession, validSession
} from '../lib/auth.js';

export default async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.SUD_SESSION_SECRET) {
    return json(res, 503, { error: 'Speicher nicht bereit' });
  }
  if (req.method === 'GET') {
    try {
      const record = await readPasswordRecord();
      return json(res, 200, { configured: Boolean(record), authenticated: validSession(req, record) });
    } catch {
      return json(res, 503, { error: 'Speicher nicht erreichbar' });
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Nicht erlaubt' });
  }
  if (rejectCrossOrigin(req)) return json(res, 403, { error: 'Herkunft nicht erlaubt' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return json(res, 415, { error: 'Ungültiger Datentyp' });
  }
  if (Number(req.headers['content-length'] || 0) > 1200) return json(res, 413, { error: 'Anfrage zu groß' });
  try {
    const input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!input || typeof input !== 'object') return json(res, 400, { error: 'Ungültige Anfrage' });
    const record = await readPasswordRecord();
    if (input.action === 'logout') {
      clearSession(res);
      return json(res, 200, { ok: true });
    }
    if (input.action === 'setup') {
      if (record) return json(res, 409, { error: 'Passwort bereits festgelegt' });
      await initialSetup(input.password, input.setupToken);
      const configured = await readPasswordRecord();
      if (!configured) return json(res, 503, { error: 'Bitte erneut anmelden' });
      createSession(res, configured);
      return json(res, 200, { ok: true });
    }
    if (!record) return json(res, 409, { error: 'Passwort noch nicht eingerichtet' });
    if (input.action === 'login') {
      if (!passwordValid(input.password) || !(await checkPassword(input.password, record))) {
        await new Promise(resolve => setTimeout(resolve, 400));
        return json(res, 401, { error: 'Passwort ist falsch' });
      }
      createSession(res, record);
      return json(res, 200, { ok: true });
    }
    if (input.action === 'change') {
      if (!validSession(req, record)) return json(res, 401, { error: 'Anmeldung erforderlich' });
      if (!safeEqual(input.setupToken, process.env.SUD_BOOTSTRAP_TOKEN)) return json(res, 403, { error: 'Nur der Einrichtungslink darf das Passwort ändern' });
      if (!passwordValid(input.password)) return json(res, 400, { error: 'Mindestens 12 Zeichen erforderlich' });
      await updatePassword(input.password, record);
      const updated = await readPasswordRecord();
      if (!updated) return json(res, 503, { error: 'Neues Passwort gesetzt, bitte erneut anmelden' });
      createSession(res, updated);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'Unbekannte Aktion' });
  } catch (error) {
    if (typeof error.status === 'number') return json(res, error.status, { error: error.message });
    console.error('Auth request failed:', error?.name || 'Unknown');
    return json(res, 500, { error: 'Zugriff derzeit nicht möglich' });
  }
}
