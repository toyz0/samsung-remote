// Regression tests for the three bugs that were easiest to get wrong, and
// easiest to reintroduce: the static allowlist, the collapsing of writes, and
// the message guard. No TV and no network is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');

const { handler, jsonStore, parseMessage } = require('../server.js');

/** Minimal stand-in for ServerResponse: records what the handler sent. */
function fakeRes() {
  return {
    code: null,
    body: '',
    writeHead(code) { this.code = code; },
    end(chunk) { this.body = chunk ? Buffer.from(chunk).toString() : ''; },
  };
}

async function get(url) {
  const res = fakeRes();
  await handler({ method: 'GET', url, headers: {} }, res);
  return res;
}

test('static: only the remote page is served', async () => {
  for (const url of ['/', '/index.html']) {
    const res = await get(url);
    assert.equal(res.code, 200, `${url} should be served`);
    assert.match(res.body, /<html/i);
  }
});

test('static: no spelling of a private file is served', async () => {
  // Windows opens files case-insensitively and resolves the default NTFS data
  // stream, so each of these reaches tokens.json / tvs.json on disk.
  const urls = [
    '/tokens.json', '/TOKENS.JSON', '/Tokens.Json',
    '/tvs.json', '/TVS.JSON',
    '/tokens.json::$DATA',
    '/server.js', '/README.md', '/package.json',
    '/.gitignore', '/.impeccable/config.json',
    '/../tokens.json', '/%2e%2e/tokens.json',
  ];

  for (const url of urls) {
    const res = await get(url);
    assert.notEqual(res.code, 200, `${url} must not be served`);
    assert.doesNotMatch(res.body, /token/i, `${url} leaked file contents`);
  }
});

test('cross-site POST is refused before anything runs', async () => {
  const res = fakeRes();
  await handler(
    { method: 'POST', url: '/scan', headers: { 'sec-fetch-site': 'cross-site' } },
    res,
  );
  assert.equal(res.code, 403);
});

test('a malformed request target answers 400 instead of throwing', async () => {
  const res = fakeRes();
  await handler({ method: 'GET', url: 'http://', headers: {} }, res);
  assert.equal(res.code, 400);
});

test('store: a change made mid-write still reaches disk', async (t) => {
  let release;
  const writes = [];
  t.mock.method(fsp, 'writeFile', (_file, body) => {
    writes.push(body);
    // Hold the first write open so the second save lands while it is in flight.
    return writes.length === 1 ? new Promise(r => { release = r; }) : Promise.resolve();
  });

  // The name does not exist, so the store starts empty and never reads a real file.
  const store = jsonStore('test-does-not-exist.json');

  store.data.first = 1;
  const inFlight = store.save();
  store.data.second = 2;
  store.save();

  release();
  await inFlight;
  // The follow-up write is scheduled from .finally(), one microtask later.
  await new Promise(r => setImmediate(r));

  assert.equal(writes.length, 2, 'the newest state must be written again');
  assert.deepEqual(JSON.parse(writes.at(-1)), { first: 1, second: 2 });
});

test('store: a quiet store writes once', async (t) => {
  const writes = [];
  t.mock.method(fsp, 'writeFile', (_file, body) => { writes.push(body); return Promise.resolve(); });

  const store = jsonStore('test-does-not-exist.json');
  store.data.only = 1;
  await store.save();
  await new Promise(r => setImmediate(r));

  assert.equal(writes.length, 1);
});

test('parseMessage: unusable payloads are dropped, not thrown', () => {
  for (const raw of ['null', 'false', '0', '"ms.channel.connect"', '[]', '{', '', '{"data":{}}']) {
    assert.equal(parseMessage(Buffer.from(raw)), null, `${raw} should be dropped`);
  }
});

test('parseMessage: the two events the TV really sends get through', () => {
  const connect = parseMessage(Buffer.from(
    JSON.stringify({ event: 'ms.channel.connect', data: { token: '12345678' } }),
  ));
  assert.equal(connect.event, 'ms.channel.connect');
  assert.equal(connect.data.token, '12345678');

  assert.equal(
    parseMessage(Buffer.from('{"event":"ms.channel.unauthorized"}')).event,
    'ms.channel.unauthorized',
  );
});
