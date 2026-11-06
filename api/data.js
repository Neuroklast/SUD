import { get, put, copy, head, list, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import '../sync-core.js';
import { json, readPasswordRecord, validSession, rejectCrossOrigin } from '../lib/auth.js';

const { mergeData, equal } = globalThis.SUDSync;
const LEGACY_PATH = 'sud/timeline-v2.json';
const BASE_PATH = 'sud/sync-v3/baseline.json';
const CHANGES_PREFIX = 'sud/sync-v3/changes/';
const LIMIT = 750_000;
const REQUEST_LIMIT = LIMIT * 2 + 80_000;
const MAX_OPERATIONS = 10_000;
const EMPTY = () => ({ version: 1, events: [], clusters: [] });
const operationCache = new Map(); // Immutable records only; an optimization, not a correctness dependency.
let cachedBase = null;

function dataKey() {
  const value = Buffer.from(process.env.SUD_DATA_KEY || '', 'base64');
  if (value.length !== 32) throw new Error('Invalid data encryption key');
  return value;
}
function pack(data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: 'sud-storage-v2',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}
function unpack(raw) {
  const envelope = JSON.parse(raw);
  if (envelope.format !== 'sud-storage-v2') throw new Error('Unsupported storage format');
  const decipher = createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}
function validData(value) {
  return value && typeof value === 'object' && Number(value.version) === 1 &&
    Array.isArray(value.events) && Array.isArray(value.clusters) &&
    value.events.length <= 20_000 && value.clusters.length <= 1500;
}
function storageError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}
function missing(error) {
  return error instanceof BlobNotFoundError || error?.name === 'BlobNotFoundError';
}
function alreadyExists(error) {
  return error instanceof BlobPreconditionFailedError ||
    /already exists|precondition|condition not met|conflict/i.test(error?.message || '');
}
async function loadPrivate(path) {
  const result = await get(path, { access: 'private', useCache: false });
  if (!result || result.statusCode === 404 || !result.stream) {
    throw storageError('STORED_FILE_UNAVAILABLE', 'Private document is missing');
  }
  const raw = await new Response(result.stream).text();
  if (raw.length > REQUEST_LIMIT * 2) throw storageError('STORED_FILE_TOO_LARGE', 'Storage item too large', 413);
  return { data: unpack(raw), etag: result.blob.etag };
}

// A one-time, immutable, encrypted copy of the previous data file.
// The old file is never deleted or overwritten. Direct PUTs are disabled
// before migration so legacy clients cannot modify the baseline.
async function ensureBaseline() {
  try {
    await head(BASE_PATH);
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    let legacy;
    try {
      legacy = await head(LEGACY_PATH);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (legacy) {
      await copy(legacy.url, BASE_PATH, {
        access: 'private', allowOverwrite: false
      });
    } else {
      await put(BASE_PATH, pack(EMPTY()), {
        access: 'private', allowOverwrite: false, contentType: 'application/json'
      });
    }
  } catch (error) {
    // Concurrent first visits may have initialized the same immutable base.
    try { await head(BASE_PATH); return; }
    catch (verifyError) {
      if (!missing(verifyError)) throw verifyError;
      if (alreadyExists(error)) throw storageError('BASELINE_INITIALIZATION_RETRY', 'Retry migration');
      throw error;
    }
  }
}
async function baseline() {
  if (cachedBase) return cachedBase;
  await ensureBaseline();
  const current = await loadPrivate(BASE_PATH);
  if (!validData(current.data)) throw storageError('INVALID_BASELINE', 'Invalid baseline data', 502);
  cachedBase = current;
  return current;
}
async function listOperations() {
  const all = [];
  let cursor;
  do {
    const page = await list({ prefix: CHANGES_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.blobs)) throw storageError('STORAGE_LIST_UNAVAILABLE', 'Operation list unavailable');
    all.push(...page.blobs);
    if (all.length > MAX_OPERATIONS) {
      throw storageError('STORAGE_JOURNAL_FULL', 'Journal needs controlled compaction', 507);
    }
    if (page.hasMore && (!page.cursor || page.cursor === cursor)) {
      throw storageError('STORAGE_CURSOR_INVALID', 'Invalid journal cursor', 502);
    }
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  all.sort((a, b) => (+new Date(a.uploadedAt) - +new Date(b.uploadedAt)) ||
    a.pathname.localeCompare(b.pathname));
  return all;
}
async function loadOperation(blob) {
  if (operationCache.has(blob.pathname)) return operationCache.get(blob.pathname);
  const loaded = await loadPrivate(blob.pathname);
  const op = loaded.data;
  if (op?.format !== 'sud-change-v1' || !validData(op.base) || !validData(op.data)) {
    throw storageError('INVALID_OPERATION', 'Invalid journal record', 502);
  }
  if (operationCache.size > 512) operationCache.clear();
  operationCache.set(blob.pathname, op);
  return op;
}
async function snapshot(knownEtag = null, requiredPath = null) {
  const original = await baseline();
  const operations = await listOperations();
  if (requiredPath && !operations.some(item => item.pathname === requiredPath)) {
    throw storageError('OPERATION_NOT_VISIBLE', 'New change is pending index visibility');
  }
  const hash = createHash('sha256').update(original.etag || 'base');
  for (const item of operations) hash.update('\n' + item.pathname + ':' + item.etag);
  const etag = '"' + hash.digest('hex') + '"';
  if (knownEtag === etag) return { unchanged: true, etag };
  let document = original.data;
  // Apply each independent edit relative to the base that its author saw.
  // No writer ever overwrites another writer's blob.
  for (const item of operations) {
    const op = await loadOperation(item);
    document = mergeData(op.base, op.data, document).data;
  }
  if (!validData(document)) throw storageError('INVALID_RESULT', 'Merged state invalid', 502);
  return { data: document, etag, count: operations.length };
}

async function appendChange(base, incoming) {
  if (equal(base, incoming)) return snapshot();
  const op = { format: 'sud-change-v1', base, data: incoming };
  const fingerprint = createHash('sha256').update(JSON.stringify(op)).digest('hex');
  const pathname = CHANGES_PREFIX + fingerprint + '.json';
  try {
    await put(pathname, pack(op), {
      access: 'private',
      allowOverwrite: false,
      contentType: 'application/json',
      cacheControlMaxAge: 60
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    // Duplicate HTTP request after a network loss: verify the immutable
    // record instead of writing again or using an unsafe overwrite.
    const existing = await loadPrivate(pathname);
    if (createHash('sha256').update(JSON.stringify(existing.data)).digest('hex') !== fingerprint) {
      throw storageError('OPERATION_ID_COLLISION', 'An existing change did not match', 409);
    }
  }
  // A successful put must become visible in the authoritative list before
  // clients mark it as synchronized. Otherwise preserve the pending local edit.
  return snapshot(null, pathname);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH');
    return json(res, req.method === 'PUT' ? 426 : 405, {
      code: 'UPDATE_REQUIRED',
      error: 'Bitte die Anwendung neu laden, um sicher weiterarbeiten zu können.'
    });
  }
  if (req.method === 'PATCH' &&
      (rejectCrossOrigin(req) || !String(req.headers['content-type'] || '').startsWith('application/json'))) {
    return json(res, 403, { error: 'Anfrage nicht erlaubt' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.SUD_SESSION_SECRET || !process.env.SUD_DATA_KEY) {
    return json(res, 503, { code: 'STORAGE_NOT_CONFIGURED', error: 'Speicher nicht bereit' });
  }

  try {
    const record = await readPasswordRecord();
    if (!validSession(req, record)) return json(res, 401, { error: 'Anmeldung erforderlich' });
    if (req.method === 'GET') {
      const known = req.headers['if-none-match'];
      const state = await snapshot(typeof known === 'string' && known.length < 150 ? known : null);
      if (state.unchanged) {
        res.statusCode = 304;
        res.setHeader('ETag', state.etag);
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        return res.end();
      }
      res.setHeader('ETag', state.etag);
      return json(res, 200, { data: state.data, etag: state.etag });
    }

    if (Number(req.headers['content-length'] || 0) > REQUEST_LIMIT) {
      return json(res, 413, { code: 'PAYLOAD_TOO_LARGE', error: 'Datensatz zu groß' });
    }
    const input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!input || !validData(input.base) || !validData(input.data) ||
        Buffer.byteLength(JSON.stringify(input), 'utf8') > REQUEST_LIMIT) {
      return json(res, 400, { error: 'Ungültiger Datenstand' });
    }
    const saved = await appendChange(input.base, input.data);
    return json(res, 200, { ok: true, data: saved.data, etag: saved.etag, conflictCount: 0 });
  } catch (error) {
    if (error?.status) {
      if (error.status === 503) res.setHeader('Retry-After', '5');
      return json(res, error.status, {
        code: error.code,
        error: error.status >= 500
          ? 'Cloud ist momentan nicht erreichbar. Änderungen bleiben lokal erhalten.'
          : error.message
      });
    }
    console.error('SUD journal operation failed:', error?.name || 'UnknownError');
    res.setHeader('Retry-After', '10');
    return json(res, 503, {
      code: 'STORAGE_REQUEST_FAILED',
      error: 'Cloud-Speicherung fehlgeschlagen. Änderungen bleiben lokal erhalten.'
    });
  }
}
