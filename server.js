// Local-only bridge between the browser and a Samsung Tizen TV.
//
// Why a server at all: the TV only accepts remote-control commands on
// wss://IP:8002 (ws://IP:8001 answers ms.channel.unauthorized and hangs up),
// and it presents a self-signed certificate (CN=SmartViewSDK). A browser gives
// you no way to accept a certificate exception for a WebSocket, so the socket
// to the TV has to live outside the browser. The page talks plain HTTP to this
// process instead.
//
// Uses the `ws` package rather than Node's built-in global WebSocket: the TV
// completes the upgrade with the built-in client but then never sends a single
// frame, because undici always offers permessage-deflate and this firmware goes
// silent when it is negotiated. `ws` lets us turn the extension off and skip
// certificate validation per socket, instead of process-wide.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8099;
const CLIENT_NAME = 'WebRemote';
const ROOT = __dirname;

// A TV is identified by its duid, not its address: DHCP moves the address, and
// the duid is the only stable handle the TV hands out without authentication.
const DUID_RE = /^uuid:[0-9a-f-]{36}$/i;
const KEY_RE = /^KEY_[A-Z0-9_]{1,24}$/;

// ---------- tiny JSON stores ----------

function jsonStore(name) {
  const file = path.join(__dirname, name);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }

  let saving = null;
  let dirty = false;
  const store = {
    get data() { return data; },
    save() {
      // Collapse bursts of writes, but never drop the newest state: the data is
      // serialised when the write starts, so a change arriving mid-write — one
      // of 254 scan hits, or a token from a second TV — is only on disk if we
      // write once more afterwards.
      if (saving) { dirty = true; return saving; }
      saving = fsp.writeFile(file, JSON.stringify(data, null, 2))
        .catch(err => console.error(`${name} save failed:`, err.message))
        .finally(() => {
          saving = null;
          if (dirty) { dirty = false; store.save(); }
        });
      return saving;
    },
  };
  return store;
}

// duid -> token, so the TV's Allow prompt appears once per TV, ever.
const tokenStore = jsonStore('tokens.json');
// duid -> { ip, name, modelName, lastSeen }. Only a hint; it may be stale.
const tvStore = jsonStore('tvs.json');

// ---------- discovery ----------

/** The /24 prefix of the first real IPv4 address, e.g. "192.168.1". */
function localSubnet() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        return a.address.split('.').slice(0, 3).join('.');
      }
    }
  }
  return null;
}

/** Ask one address who it is. Plain HTTP, no auth, no TLS. */
async function probe(ip, timeoutMs = 1000) {
  try {
    const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const device = (await res.json())?.device;
    if (!device?.duid) return null;
    return {
      duid: device.duid,
      ip,
      // The TV really does return HTML entities here, e.g. 43&quot; Crystal UHD.
      name: String(device.name ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      modelName: device.modelName ?? '',
    };
  } catch {
    return null;
  }
}

function remember(dev) {
  tvStore.data[dev.duid] = { ip: dev.ip, name: dev.name, modelName: dev.modelName, lastSeen: Date.now() };
  tvStore.save();
}

let scanning = null;

/** Probe every host of the local /24 at once. Measured at ~1s for a 254-host sweep. */
function scan() {
  // Two key presses arriving during one sweep must not start two sweeps.
  if (scanning) return scanning;

  const subnet = localSubnet();
  if (!subnet) return Promise.reject(new Error('No local subnet found on this machine'));

  const started = Date.now();
  scanning = Promise.all(
    Array.from({ length: 254 }, (_, i) => probe(`${subnet}.${i + 1}`))
  ).then(results => {
    const found = results.filter(Boolean);
    found.forEach(remember);
    console.log(`scan ${subnet}.0/24: ${found.length} TV(s) in ${Date.now() - started}ms`);
    return found;
  }).finally(() => { scanning = null; });

  return scanning;
}

/** Current address of a TV, re-scanning only when the cached one is wrong. */
async function resolve(duid) {
  const cached = tvStore.data[duid];

  if (cached?.ip) {
    const dev = await probe(cached.ip);
    if (dev?.duid === duid) {
      remember(dev);
      return dev.ip;
    }
    console.log(`[${duid}] not at ${cached.ip} any more, scanning`);
  }

  const found = await scan();
  const hit = found.find(d => d.duid === duid);
  if (hit) return hit.ip;

  const label = cached?.name || duid;
  throw new Error(`TV "${label}" not found on this LAN — is it switched on?`);
}

/**
 * Tokens were keyed by IP before TVs were identified by duid. Carry an old
 * entry over the first time we learn the address, so the TV does not re-prompt.
 */
function migrateToken(duid, ip) {
  const tokens = tokenStore.data;
  if (tokens[duid] || !tokens[ip]) return;
  tokens[duid] = tokens[ip];
  delete tokens[ip];
  tokenStore.save();
  console.log(`[${duid}] token migrated from ${ip}`);
}

// ---------- one live socket per TV ----------

/** duid -> live socket. @type {Map<string, {ws: WebSocket, ready: Promise<void>}>} */
const conns = new Map();

/**
 * A usable TV message, or null. `JSON.parse` accepts `null` and bare scalars,
 * and reading .event off those throws inside the socket callback, where nothing
 * catches it and the whole process goes down with it.
 */
function parseMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return null; }
  if (!msg || typeof msg !== 'object' || typeof msg.event !== 'string') return null;
  return msg;
}

function openTv(duid, ip) {
  const tokens = tokenStore.data;
  const token = tokens[duid];
  let url = `wss://${ip}:8002/api/v2/channels/samsung.remote.control`
          + `?name=${encodeURIComponent(Buffer.from(CLIENT_NAME).toString('base64'))}`;
  if (token) url += `&token=${encodeURIComponent(token)}`;

  const ws = new WebSocket(url, {
    rejectUnauthorized: false,   // the TV's cert is self-signed (CN=SmartViewSDK)
    perMessageDeflate: false,    // the TV sends nothing at all if this is offered
    handshakeTimeout: 10_000,
  });
  const entry = { ws, ready: null };

  // Any failure must take the entry out of the map, or every later key press
  // would await the same already-rejected promise and report a stale error.
  const drop = () => {
    if (conns.get(duid) === entry) conns.delete(duid);
    if (ws.readyState <= WebSocket.OPEN) ws.close();
  };

  entry.ready = new Promise((resolve, reject) => {
    // The TV can sit on its Allow prompt for a while before answering.
    const timer = setTimeout(() => {
      reject(new Error('No answer from the TV in 35s — check its screen for a waiting Allow box'));
    }, 35_000);

    ws.on('message', raw => {
      const msg = parseMessage(raw);
      if (!msg) return;

      if (msg.event === 'ms.channel.connect') {
        clearTimeout(timer);
        if (typeof msg.data?.token === 'string' && msg.data.token !== tokens[duid]) {
          tokens[duid] = msg.data.token;
          tokenStore.save();
          console.log(`[${ip}] token stored`);
        }
        console.log(`[${ip}] ready`);
        resolve();
      } else if (msg.event === 'ms.channel.unauthorized') {
        clearTimeout(timer);
        // A stale token is rejected outright; drop it so the next try prompts.
        delete tokens[duid];
        tokenStore.save();
        reject(new Error('The TV refused the connection — press Allow on its screen and try again'));
      }
    });

    ws.on('error', err => {
      clearTimeout(timer);
      console.error(`[${ip}] socket error: ${err.message}`);
      // A TV that has not granted this client hangs up with close code 1005,
      // which is reserved and must never appear on the wire, so `ws` reports it
      // as a frame error rather than a close. Treat it as "not allowed yet".
      reject(/invalid status code 1005/.test(err.message)
        ? new Error(`TV ${ip} hung up at once — it has not granted this client. `
                  + 'On the TV: Settings > General > External Device Manager > '
                  + 'Device Connection Manager > Device List, then allow "WebRemote"')
        : new Error(`Cannot reach ${ip}:8002 — is the TV off, or on another LAN?`));
    });

    ws.on('close', () => {
      clearTimeout(timer);
      reject(new Error('The connection to the TV was closed'));
    });
  });

  entry.ready.catch(drop);
  ws.on('close', drop);
  conns.set(duid, entry);
  return entry;
}

async function sendKey(duid, key) {
  let entry = conns.get(duid);

  if (!entry) {
    // Only when there is no live socket do we pay for an address lookup, so a
    // run of key presses costs one WebSocket frame each and nothing more.
    const ip = await resolve(duid);
    migrateToken(duid, ip);
    // The lookup above awaited, so a key press that arrived behind this one may
    // have opened the socket in the meantime. Opening a second one would leave
    // the first untracked in the map and never closed.
    entry = conns.get(duid) ?? openTv(duid, ip);
  }

  await entry.ready;
  if (entry.ws.readyState !== WebSocket.OPEN) throw new Error('The connection to the TV was closed');

  entry.ws.send(JSON.stringify({
    method: 'ms.remote.control',
    params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
  }));
}

// ---------- http ----------

/** Cached TVs, most recently seen first. */
function knownTvs() {
  return Object.entries(tvStore.data)
    .map(([duid, tv]) => ({ duid, ...tv }))
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

function json(res, code, body) {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}

// No path from the URL ever reaches the filesystem: tokens.json, tvs.json, the
// dot-directories and this very file all sit in ROOT, and name matching is the
// filesystem's business, not ours — on Windows /TOKENS.JSON and
// tokens.json::$DATA both open tokens.json. An allowlist cannot be spelled
// around. Serving a new asset means one more entry here.
const STATIC = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
]);

async function serveStatic(res, urlPath) {
  const hit = STATIC.get(urlPath);
  if (!hit) return json(res, 404, { error: 'not found' });

  try {
    const body = await fsp.readFile(path.join(ROOT, hit.file));
    res.writeHead(200, { 'content-type': hit.type });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const handler = async (req, res) => {
  // There is no login, so the one thing standing between another site the user
  // has open and their TV is the browser telling us where the request came
  // from. A client that sends no Sec-Fetch-Site at all (curl, scan-tv.ps1) is
  // still served: this stops drive-by pages, it is not authentication.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return json(res, 403, { error: 'cross-site request refused' });
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return json(res, 400, { error: 'bad request target' });
  }

  if (req.method === 'POST' && url.pathname === '/key') {
    const duid = url.searchParams.get('duid') || '';
    const key = url.searchParams.get('key') || '';

    if (!DUID_RE.test(duid)) return json(res, 400, { error: 'bad duid' });
    if (!KEY_RE.test(key)) return json(res, 400, { error: 'bad key' });

    try {
      await sendKey(duid, key);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/scan') {
    try {
      await scan();
      return json(res, 200, { tvs: knownTvs() });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/tvs') {
    return json(res, 200, { tvs: knownTvs() });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);
  json(res, 405, { error: 'method not allowed' });
};

const server = http.createServer(handler);

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — another copy of this server is `
                + `probably still running. Stop it, or start this one on another `
                + `port with:  PORT=8100 node server.js`);
    process.exit(1);
  }
  throw err;
});

// Required by the tests as a module; only the real run opens the port.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Samsung remote: http://localhost:${PORT}`);
    console.log('Anyone on this LAN who can reach this port can control the TV.');
  });
}

module.exports = { handler, jsonStore, parseMessage };
