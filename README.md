<div align="center">

# Samsung TV Remote Control Web App

**A remote control for your Samsung TV, in a browser tab on your own machine.**

Finds the TVs by itself. Keeps working after their IP addresses change.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
![Dependencies](https://img.shields.io/badge/dependencies-1-blue)
![Build step](https://img.shields.io/badge/build%20step-none-brightgreen)
![Tests](https://img.shields.io/badge/npm%20test-8%20passing-brightgreen)
[![Made with Claude Code](https://img.shields.io/badge/made%20with-Claude%20Code-D97757)](#made-with-claude-code)

</div>

```
npm install
node server.js        →  http://localhost:8099
```

Pick a TV from the dropdown, press a key. That is the whole setup.

> [!WARNING]
> **There is no authentication, and the server listens on every interface.**
> Anyone who can reach port 8099 can control your TV. Keep it on your own LAN and
> never port-forward it. See [Security](#security).

---

## Contents

| | |
| --- | --- |
| [Requirements](#requirements) · [Run](#run) · [Allowing a TV](#allowing-a-tv) · [Finding TVs](#finding-tvs) | Using it |
| [Security](#security) · [Private files](#private-files) · [Resetting and revoking](#resetting-and-revoking) | Keeping it safe |
| [Project layout](#project-layout) · [How a key press travels](#how-a-key-press-travels) · [Why a server exists](#why-a-server-exists-at-all) · [Traps already hit](#traps-already-hit) | Changing it |
| [Adding keys](#adding-keys) · [HTTP API](#http-api) · [Testing a change](#testing-a-change) · [Scope](#scope) | Reference |

---

## Requirements

| | |
| --- | --- |
| **Node** | 18 or newer for the server (`fetch`, `AbortSignal.timeout`). 20 or newer to run `npm test`, which uses `node:test` mocking. Developed on v24.19.0. |
| **TV** | Samsung Tizen, switched on, on the same `/24` subnet as this machine. |
| **Everything else** | One npm dependency (`ws`). No build step, no framework, no config file. |

## Run

```bash
npm install
node server.js
```

Open <http://localhost:8099>. The dropdown fills by itself.

```bash
PORT=9000 node server.js     # a different port
npm test                     # the unit tests, no TV needed
```

## Allowing a TV

The first time a TV sees this client it must grant it. Either accept the Allow box
that appears on the TV screen, or go to **Settings › General › External Device
Manager › Device Connection Manager › Device List** and allow `WebRemote`.

Once granted, the TV issues a token, stored in `tokens.json` under the TV's
`duid`. Later runs connect without prompting, wherever the TV's address has moved
to since.

A TV that has not granted the client hangs up immediately, and the page says so.

## Finding TVs

Nothing is addressed by IP. A TV is identified by the `duid` it reports on
`http://IP:8001/api/v2/`, a plain-HTTP endpoint that needs no authentication, and
`tvs.json` caches the address last seen for each one.

Before each connection the server checks the cached address. If the TV is no
longer there — a new DHCP lease, a router reboot — it probes all 254 addresses of
the local `/24` at once, which takes about a second, finds the same `duid` at its
new address and carries on. Key presses keep working and nothing needs editing.
The `⟳` button forces the same sweep.

`tvs.json` is only a cache and is safe to delete.

<details>
<summary><b>Discovery from PowerShell instead</b></summary>

`scan-tv.ps1` does the same discovery and also reports non-Samsung devices such
as Chromecasts and Rokus:

```powershell
powershell -ExecutionPolicy Bypass -File .\scan-tv.ps1
powershell -ExecutionPolicy Bypass -File .\scan-tv.ps1 -SelfTest
```

</details>

---

## Security

**There is no authentication.** Anyone who can reach port 8099 can control the TV,
and the server listens on every interface, not just loopback. Keep it on your own
LAN and do not port-forward it. To restrict it to this machine, pass the host to
`server.listen`:

```js
server.listen(PORT, '127.0.0.1', () => { /* … */ });
```

What the server *does* do:

| Protection | Behaviour |
| --- | --- |
| **Static allowlist** | Only `/` and `/index.html` are served. Every other path is a 404, whatever its name. No path from the URL reaches the filesystem at all. |
| **Cross-site refusal** | A request whose `Sec-Fetch-Site` header says `cross-site` or `same-site` gets a 403 before any routing, so another site open in your browser cannot make it scan your LAN or press keys. |
| **Input validation** | `duid` must match `/^uuid:[0-9a-f-]{36}$/i` and `key` must match `/^KEY_[A-Z0-9_]{1,24}$/`. Anything else is a 400. |

> [!NOTE]
> The cross-site check relies on the browser telling the truth about where the
> request came from. A client that sends no `Sec-Fetch-Site` header at all —
> `curl`, `scan-tv.ps1`, anything that is not a browser — is served as before.
> It stops drive-by pages. It is not authentication.

### Private files

Running the server creates files that describe your own home network. They are all
in `.gitignore`, and none of them is reachable over HTTP, but know what they are
before you share a clone, a branch or a log.

| Path | Contains | Why it matters |
| --- | --- | --- |
| `tokens.json` | Pairing token per TV | **A credential.** Anyone holding it who can reach your LAN controls the TV without the Allow prompt. |
| `tvs.json` | Device UUIDs, LAN addresses, TV model numbers | An inventory of your home: which rooms have which TVs. |
| `.impeccable/` | Local tooling state | Holds absolute paths, so it leaks your machine's user name. |

**There is nothing to set up after cloning.** All three are generated. A fresh
clone has none of them: `tvs.json` appears on the first scan, and `tokens.json`
when a TV grants the client. Do not copy another machine's copies over.

### Resetting and revoking

> [!IMPORTANT]
> **Deleting `tokens.json` revokes nothing.** The TV keeps its own record of the
> `WebRemote` client and simply issues a new token on the next connection. The
> only thing that revokes access is removing the client *on the TV*:
>
> **Settings › General › External Device Manager › Device Connection Manager ›
> Device List** → remove `WebRemote`.
>
> Then delete the local file too, so the next run pairs cleanly.

**Do that now if any of these is true:**

- You ran a version of this server from **before 2026-10-24** on a network you do
  not fully trust. Until then a request such as `GET /TOKENS.JSON` or
  `GET /tokens.json::$DATA` returned the file, because the filter compared names
  case-sensitively while Windows opens files case-insensitively and resolves the
  default NTFS data stream. Anyone who could reach the port could read the token.
  Fixed; see [Testing a change](#testing-a-change) for the check that keeps it
  fixed.
- `tokens.json` was ever committed, pushed or attached to anything.
- You copied the folder to another machine or a shared drive.

A token taken before you revoke it keeps working. Closing the program, deleting
the file and changing your Wi-Fi password do not expire it — only the TV can.

`tvs.json` can be deleted at any time; the next scan rebuilds it. Deleting it
while the server runs has no immediate effect, because the cache is held in memory
from startup.

<details>
<summary><b>If a private file was committed anyway</b></summary>

A later commit that deletes the file does not remove it from history, and
`git rm --cached` does not either — anyone with the repository can still read it
from an earlier commit. Treat the token as compromised: revoke `WebRemote` on the
TV as above, then rewrite history with `git filter-repo` or BFG and force-push. If
the repository was ever public, assume the contents were seen.

</details>

<details>
<summary><b>Logs and screenshots</b></summary>

The server prints TV addresses and `duid`s, for example
`[uuid:…] not at 192.168.1.42 any more, scanning`. Strip those before attaching a
log to an issue.

</details>

---

# Developing

## Project layout

| File | Role |
| --- | --- |
| `index.html` | The whole UI: markup, CSS and script in one file. No build step. |
| `server.js` | Static serving, discovery, and one WebSocket per TV. |
| `test/server.test.js` | `node --test` unit tests. No TV, no network. |
| `scan-tv.ps1` | Standalone PowerShell discovery, with a `-SelfTest` mode. |
| `tokens.json` | `duid` → pairing token. Generated, secret. |
| `tvs.json` | `duid` → `{ ip, name, modelName, lastSeen }`. Generated cache. |

`server.js` exports `{ handler, jsonStore, parseMessage }` for the tests and only
opens the port under `require.main === module`.

## How a key press travels

```
button click
  └─ POST /key?duid=uuid:…&key=KEY_VOLUP
       └─ sendKey(duid, key)
            ├─ live socket for this duid?  → reuse it
            └─ no socket:
                 ├─ resolve(duid)
                 │    ├─ probe(cached ip) → duid matches? use it
                 │    └─ otherwise scan() the /24 (~1s) and update the cache
                 ├─ migrateToken(duid, ip)
                 ├─ socket opened while we awaited? → use that one
                 └─ openTv(duid, ip) → wss://ip:8002
                      └─ {"method":"ms.remote.control", params:{Cmd:"Click", …}}
```

Only the first press of a session pays for the lookup; after that the socket is
reused and a press costs one WebSocket frame.

## Why a server exists at all

This is the part worth knowing before changing anything.

- **The TV only accepts commands on `wss://IP:8002`.** Port 8001 completes the
  WebSocket handshake, answers `{"event":"ms.channel.unauthorized"}` and hangs up.
  It is useful only for the unauthenticated `GET /api/v2/` device-info endpoint,
  which is what discovery uses.
- **Port 8002 serves a self-signed certificate** (`CN=SmartViewSDK` on older
  firmware, `CN=Samsung SmartViewSDK Cert. G2` on newer), and a browser offers no
  way to accept a certificate exception for a WebSocket. So the socket cannot live
  in the page, and `server.js` holds it instead.

## Traps already hit

Each of these cost real time. **Do not undo them.**

- **Node's built-in global `WebSocket` does not work with these TVs.** The upgrade
  succeeds and then the TV sends nothing, ever, because undici always offers
  `permessage-deflate`. The `ws` package is used with `perMessageDeflate: false`.
  This is the only reason there is a dependency.
- **A TV that has not granted the client closes with code `1005`**, which is
  reserved and must never appear on the wire, so `ws` surfaces it as
  `Invalid WebSocket frame: invalid status code 1005` — an `error`, not a `close`.
  That string is matched to produce a useful message.
- **The TV returns HTML entities in `name`**, e.g. `43&quot; Crystal UHD`. Both
  `probe()` and `scan-tv.ps1` decode them.
- **A failed connection must be removed from the `conns` map.** Otherwise every
  later key press awaits the same already-rejected promise and reports a stale
  error forever.
- **`JSON.parse` accepts `null` and bare scalars.** Reading `.event` off those
  throws inside the socket callback, where nothing catches it and the process
  exits. Every message goes through `parseMessage()`, which returns `null` for
  anything without a string `event`.
- **`jsonStore.save()` serialises the data when the write starts.** A change
  arriving mid-write — one of 254 scan hits, or a token from a second TV — is only
  on disk because a dirty flag schedules one more write afterwards. Collapsing
  writes without that flag silently loses state.
- **Re-check `conns` after every `await` in `sendKey()`.** Two first presses
  arriving together both finish their lookup, and without the re-check both open a
  socket; the first is left untracked in the map and never closed.
- **Never match private filenames by hand.** On Windows `/TOKENS.JSON` and
  `/tokens.json::$DATA` both open `tokens.json`. The `STATIC` map is an allowlist
  precisely because a denylist cannot be spelled around.
- **Deleting `tvs.json` while the server runs does not clear the cache.** It is
  loaded into memory at startup; the file is rewritten on the next successful
  probe. Restart to reload from disk.

## Adding keys

Add a button to `index.html` with a `data-key` attribute; the existing delegated
listener picks it up and no JavaScript changes are needed.

```html
<button data-key="KEY_INFO">Info</button>
```

Key names are Samsung's `KEY_*` constants: `KEY_HDMI`, `KEY_GUIDE`, `KEY_INFO`,
`KEY_TOOLS`, `KEY_REWIND`, `KEY_FF`, `KEY_STOP`, `KEY_CHLIST`, and so on. The
server accepts anything matching `/^KEY_[A-Z0-9_]{1,24}$/`, so an unknown name
reaches the TV and is ignored by it rather than erroring.

To send something other than a key press — launching an app, typing text — the
message shape in `sendKey()` changes rather than the key name; see the
`ms.channel.emit` and `ms.remote.control` methods in Samsung's protocol.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` · `/index.html` | The remote page. The only static paths there are. |
| `GET` | `/tvs` | Cached TVs, most recently seen first. |
| `POST` | `/scan` | Force a sweep of the `/24`, then return the list. |
| `POST` | `/key?duid=…&key=KEY_…` | Send one key press. `{"ok":true}` or `{"error":"…"}`. |

Every other path is a 404, whatever its name: `tokens.json`, `tvs.json`, the
dot-directories and `server.js` included. Serving a new asset means adding it to
the `STATIC` map in `server.js` — there is no path resolution to extend.

Responses: `400` for a bad `duid`, `key` or request target · `403` for a
cross-site request · `404` for any other path · `405` for any other method ·
`500` when no local subnet can be determined for a scan · `502` when the TV
itself cannot be reached.

## Testing a change

```bash
npm test
```

Runs `test/server.test.js` with the built-in `node --test`: the static allowlist
(including the Windows name variants), the cross-site refusal, the JSON stores'
mid-write behaviour, and the parsing of TV messages. No TV and no network.

It proves nothing about whether a key press arrives, so these still matter, and
the volume one is the only real proof a key reached the TV.

1. **A key really arrives.** Read the TV's volume over UPnP, press Vol +, read it
   again, press Vol −, read it again. It must go `n → n+1 → n`. Only TVs that
   expose port 9197 can be checked this way.

   ```
   POST http://<tv-ip>:9197/upnp/control/RenderingControl1
   SOAPACTION: "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"

   <?xml version="1.0"?>
   <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
               s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
     <s:Body>
       <u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
         <InstanceID>0</InstanceID><Channel>Master</Channel>
       </u:GetVolume>
     </s:Body>
   </s:Envelope>
   ```

2. **Recovery from a moved address.** Edit `tvs.json` to give a TV a wrong IP such
   as `192.168.1.99`, restart the server, press a key. It must still work; the log
   should show the probe miss, a scan, and the cache rewritten. No Allow prompt
   should appear, which proves the token survived.

3. **Token persistence.** Restart and press a key. It must connect with no prompt.

4. **Nothing private is served.** `GET /tokens.json`, `/TOKENS.JSON`, `/tvs.json`,
   `/tokens.json::$DATA` and `/.impeccable/hook.cache.json` → `404` with no file
   contents, while `/index.html` → `200`.

5. **Cross-site is refused.** `POST /scan` with the header
   `Sec-Fetch-Site: cross-site` → `403`, and the log must show no sweep.

Restart the server after editing `server.js`. `index.html` is read from disk per
request, so a reload is enough.

## Scope

Samsung Tizen TVs only. `scan-tv.ps1` also reports Google Cast devices, but they
speak a different protocol (protobuf over TLS on port 8009) and are not supported
here.

Discovery is limited to one `/24`, taken from the first non-loopback IPv4 address
of this machine. A host whose virtual adapter (VPN, Hyper-V, Docker) sorts before
its real one would scan the wrong network; there is no override yet.

`duid` is assumed stable across reboots and firmware updates. This was never
verified. If it ever changes, the TV shows up as a new entry and is re-paired on
the next Allow; the fallback would be keying by MAC address, which `scan-tv.ps1`
already reads from the ARP table.

---

## Made with Claude Code

This project was written with [Claude Code](https://claude.com/claude-code),
Anthropic's CLI for Claude, in collaboration with its author. That includes the
server, the page, the PowerShell script, these docs, the tests, and the code
review that found the credential-disclosure bug described under
[Resetting and revoking](#resetting-and-revoking). That review is kept out of
this repository, because it describes the bug in enough detail to attack an
unpatched copy.

Stated plainly so you can judge the code on that basis. Everything in
[Traps already hit](#traps-already-hit) was found against a real TV; everything in
[Testing a change](#testing-a-change) marked as untested is genuinely untested.
