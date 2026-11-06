import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const event = (id, title = id, notes = '') =>
  ({ id, age: 10, sud: 5, title, notes, clusterIds: [] });
const document = (events = [], clusters = []) => ({ version: 1, events, clusters });
const empty = () => document();

function createHarness() {
  const serverSource = readFileSync(new URL('../api/data.js', import.meta.url), 'utf8')
    .replace(/^import .*?;\s*$/gm, '')
    .replace('export default async function handler', 'async function handler');
  const coreSource = readFileSync(new URL('../sync-core.js', import.meta.url), 'utf8');
  const files = new Map();
  let counter = 0;
  let putCount = 0;
  let baselineCopyCount = 0;
  class BlobNotFoundError extends Error {}
  class BlobPreconditionFailedError extends Error {}

  const file = (pathname, body) => ({
    pathname, body, etag: '"' + ++counter + '"',
    uploadedAt: new Date(Date.now() + counter)
  });
  async function head(pathname) {
    const found = files.get(pathname);
    if (!found) throw new BlobNotFoundError('Blob not found');
    return { pathname, etag: found.etag, url: 'https://store.private.blob.vercel-storage.com/' + pathname };
  }
  async function get(pathname, options) {
    assert.equal(options.access, 'private');
    assert.equal(options.useCache, false);
    const found = files.get(pathname);
    if (!found) return null;
    if (options.ifNoneMatch === found.etag) {
      return { statusCode: 304, stream: null, blob: { etag: found.etag } };
    }
    return { statusCode: 200, stream: new Response(found.body).body,
      blob: { etag: found.etag } };
  }
  async function put(pathname, body, options) {
    assert.equal(options.access, 'private');
    if (files.has(pathname)) throw new BlobPreconditionFailedError('already exists');
    files.set(pathname, file(pathname, body));
    putCount++;
    return { etag: files.get(pathname).etag };
  }
  async function copy(sourceUrl, destination, options) {
    assert.equal(options.access, 'private');
    assert.equal(options.allowOverwrite, false);
    if (files.has(destination)) throw new BlobPreconditionFailedError('already exists');
    const source = new URL(sourceUrl).pathname.slice(1);
    const found = files.get(source);
    if (!found) {
      throw new BlobPreconditionFailedError('precondition');
    }
    files.set(destination, file(destination, found.body));
    baselineCopyCount++;
    return { etag: files.get(destination).etag };
  }
  async function list({ prefix, cursor, limit }) {
    const values = [...files.values()].filter(value => value.pathname.startsWith(prefix))
      .sort((a, b) => a.pathname.localeCompare(b.pathname));
    const offset = cursor ? Number(cursor) : 0;
    const chunk = values.slice(offset, offset + limit);
    return { blobs: chunk.map(({ pathname, etag, uploadedAt }) => ({
      pathname, etag, uploadedAt
    })), hasMore: offset + limit < values.length,
    cursor: offset + limit < values.length ? String(offset + limit) : undefined };
  }
  const context = {
    Buffer, Response, setTimeout, randomBytes, createHash, createCipheriv,
    createDecipheriv, head, get, put, copy, list,
    BlobNotFoundError, BlobPreconditionFailedError,
    process: { env: {
      BLOB_READ_WRITE_TOKEN: 'test',
      SUD_SESSION_SECRET: 'test-secret',
      SUD_DATA_KEY: Buffer.alloc(32, 5).toString('base64')
    } },
    readPasswordRecord: async () => ({ version: 'test' }),
    validSession: () => true, rejectCrossOrigin: () => false,
    json(res, status, body) {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    }
  };
  runInNewContext(coreSource, context);
  runInNewContext(serverSource + '\nglobalThis.api = handler; globalThis.encrypt = pack;', context);
  async function request(method, body, headers = {}) {
    const req = { method, body, headers: {
      'content-type': 'application/json', origin: 'https://sud-livid.vercel.app', ...headers
    } };
    const res = { statusCode: 200, headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      end(value = '') { this.result = value; }
    };
    await context.api(req, res);
    return { status: res.statusCode,
      body: res.result ? JSON.parse(res.result) : null,
      headers: res.headers };
  }
  return {
    request,
    seedLegacy(data) { files.set('sud/timeline-v2.json',
      file('sud/timeline-v2.json', context.encrypt(data))); },
    get changeCount() { return [...files.keys()]
      .filter(name => name.startsWith('sud/sync-v3/changes/')).length; },
    get copyCount() { return baselineCopyCount; },
    get puts() { return putCount; },
    hasFile(name) { return files.has(name); }
  };
}

test('first read migrates existing encrypted data once, without changing the original', async () => {
  const api = createHarness();
  const original = document([event('one', 'Original', 'Existing private note')]);
  api.seedLegacy(original);
  const first = await api.request('GET');
  const second = await api.request('GET');
  assert.equal(first.status, 200);
  assert.equal(second.body.data.events[0].notes, 'Existing private note');
  assert.equal(api.copyCount, 1);
  assert.equal(api.changeCount, 0);
  assert.equal(api.hasFile('sud/timeline-v2.json'), true);
  assert.equal(api.hasFile('sud/sync-v3/baseline.json'), true);
});

test('independent parallel edits both persist as immutable operations', async () => {
  const api = createHarness();
  const base = document([event('a'), event('b')]);
  api.seedLegacy(base);
  await api.request('GET');
  const [a, b] = await Promise.all([
    api.request('PATCH', { base, data: document([event('a', 'left'), event('b')]) }),
    api.request('PATCH', { base, data: document([event('a'), event('b', 'right')]) })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const latest = await api.request('GET');
  assert.deepEqual(latest.body.data.events.map(e => e.title), ['left', 'right']);
  assert.equal(api.changeCount, 2);
});

test('changes to different fields of the same event merge without losing data', async () => {
  const api = createHarness();
  const base = document([event('a')]);
  api.seedLegacy(base);
  const title = document([event('a', 'Edited')]);
  const note = document([event('a', 'a', 'Written remotely')]);
  await api.request('PATCH', { base, data: title });
  await api.request('PATCH', { base, data: note });
  const state = await api.request('GET');
  assert.equal(state.body.data.events[0].title, 'Edited');
  assert.equal(state.body.data.events[0].notes, 'Written remotely');
});

test('retry of the same PATCH is idempotent', async () => {
  const api = createHarness();
  const base = empty();
  const update = document([event('x')]);
  const first = await api.request('PATCH', { base, data: update });
  const again = await api.request('PATCH', { base, data: update });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(api.changeCount, 1);
});

test('GET returns 304 for the current state and 200 after a new change', async () => {
  const api = createHarness();
  const base = empty();
  const first = await api.request('GET');
  const unchanged = await api.request('GET', null, { 'if-none-match': first.body.etag });
  assert.equal(unchanged.status, 304);
  await api.request('PATCH', { base, data: document([event('fresh')]) });
  const changed = await api.request('GET', null, { 'if-none-match': first.body.etag });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.events[0].id, 'fresh');
});

test('outdated PUT clients cannot overwrite the new journal', async () => {
  const api = createHarness();
  const forbidden = await api.request('PUT', { data: empty() });
  assert.equal(forbidden.status, 426);
  assert.equal(forbidden.body.code, 'UPDATE_REQUIRED');
});
