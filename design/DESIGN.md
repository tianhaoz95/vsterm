# vsterm — Local Terminal Bridge for vscode.dev

## Problem

vscode.dev runs entirely inside a browser sandbox. Terminals require spawning OS processes via PTY (pseudo-terminals), sending Unix signals, and managing file descriptors — none of which are available to browser code.

Specific constraints:

- **No process spawning** — `child_process`, `node-pty` are Node.js APIs; they do not exist in a browser context
- **No OS-level I/O** — file descriptors, stdin/stdout pipes, and signals are OS primitives, not Web APIs
- **Web extensions run in a Worker** — VS Code web extensions execute in a `SharedWorker` sandbox with no access to Node.js globals
- **Terminal contribution points are blocked** — extensions declaring `terminal` or `debuggers` in their manifest are disqualified from the web extension classification entirely
- `vscode.window.createTerminal()` simply does not exist when running in the browser host

## Prior Art

**Remote - Tunnels** (`ms-vscode.remote-server`) is the closest existing solution. It runs a full VS Code Server on your machine via `code tunnel`, then vscode.dev connects through a Microsoft-brokered relay. Terminal works because the terminal process runs server-side, not in the browser.

Drawbacks: requires a Microsoft account, all traffic routes through Microsoft's relay servers, the local daemon is a full VS Code Server (~300 MB), and it does not work offline.

No lightweight, self-hosted, open equivalent exists as a published extension.

## Solution Overview

vsterm is a two-component system: a tiny local daemon that owns all process management, and a VS Code web extension that renders a terminal UI inside a Webview and communicates with the daemon over WebSocket.

```
 ┌─────────────────────────────────────────────────────┐
 │  Browser (vscode.dev)                               │
 │                                                     │
 │  ┌─────────────────────────────────────────────┐   │
 │  │  vsterm VS Code Extension (web extension)   │   │
 │  │                                             │   │
 │  │  • Renders xterm.js in a WebviewPanel       │   │
 │  │  • Opens WebSocket → ws://localhost:7007     │   │
 │  │  • Forwards keystrokes → daemon             │   │
 │  │  • Renders PTY output from daemon           │   │
 │  └─────────────────────────────────────────────┘   │
 └──────────────────────┬──────────────────────────────┘
                        │  WebSocket  ws://localhost:7007
                        ▼
 ┌────────────────────────────────────────────────────┐
 │  Local Machine                                     │
 │                                                    │
 │  ┌──────────────────────────────────────────────┐  │
 │  │  vsterm daemon  (Go, single static binary)   │  │
 │  │                                              │  │
 │  │  • HTTP + WebSocket server on 127.0.0.1:7007 │  │
 │  │  • Spawns PTY shells via creack/pty          │  │
 │  │  • Multiplexes N terminals per connection    │  │
 │  └──────────────────────────────────────────────┘  │
 │                                                    │
 │       ┌─────────────┐    ┌─────────────┐          │
 │       │  /bin/zsh   │    │  /bin/zsh   │   ...    │
 │       └─────────────┘    └─────────────┘          │
 └────────────────────────────────────────────────────┘
```

## Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Transport | WebSocket | Only bidirectional low-latency protocol available to browser extensions |
| Terminal renderer | xterm.js in Webview | Full VT100/ANSI, resize, scrollback — same renderer VS Code itself uses |
| Daemon language | Go | Single static binary, cross-platform, `creack/pty` for PTY, zero install friction |
| Auth | None | Daemon binds 127.0.0.1 only; any local process already has equivalent access |
| Mixed-content | ws:// from https:// page | Browsers exempt `localhost` from mixed-content blocking (Chrome 94+, Firefox, Safari) |
| Terminal multiplexing | Session IDs over one WS connection | One WebSocket per browser tab, N terminals via subprotocol message IDs |
| CORS | Daemon allows `https://vscode.dev` origin | Required since vscode.dev is an https:// origin |
| Distribution | npm package (`vsterm`) | Cross-platform, no extra toolchain needed, enables `npx vsterm` for one-shot use |
| Service registration | `postinstall` script | Auto-registers as a system service on install so daemon is always running |

## Wire Protocol

All messages are JSON over a single WebSocket connection. PTY output is base64-encoded to safely carry binary escape sequences.

### Client → Daemon

```json
{ "type": "spawn",  "id": "t1", "cols": 220, "rows": 50 }
{ "type": "input",  "id": "t1", "data": "ls -la\r" }
{ "type": "resize", "id": "t1", "cols": 180, "rows": 40 }
{ "type": "kill",   "id": "t1" }
```

### Daemon → Client

```json
{ "type": "output", "id": "t1", "data": "<base64-encoded PTY bytes>" }
{ "type": "exit",   "id": "t1", "code": 0 }
{ "type": "error",  "id": "t1", "msg": "spawn failed: ..." }
```

## Repository Layout

```
vsterm/
├── design/
│   └── DESIGN.md               ← this file
│
├── daemon/                     ← Go daemon source
│   ├── main.go                 ← HTTP server, WebSocket upgrade
│   ├── session.go              ← Terminal session registry, goroutine per PTY
│   ├── pty.go                  ← PTY spawn / resize / kill via creack/pty
│   ├── go.mod
│   └── go.sum
│
├── npm/                        ← npm package (published as "vsterm")
│   ├── package.json            ← name: "vsterm", bin: { vsterm: "./bin/vsterm.js" }
│   ├── bin/
│   │   └── vsterm.js           ← Selects and execs the correct platform binary
│   ├── scripts/
│   │   ├── postinstall.js      ← Registers system service (launchd / systemd / Task Scheduler)
│   │   └── preuninstall.js     ← Unregisters system service
│   └── binaries/               ← Pre-built Go binaries per platform
│       ├── vsterm-darwin-arm64
│       ├── vsterm-darwin-x64
│       ├── vsterm-linux-arm64
│       ├── vsterm-linux-x64
│       └── vsterm-win32-x64.exe
│
└── extension/                  ← VS Code web extension
    ├── src/
    │   ├── extension.ts        ← Activation, registerCommand("vsterm.open")
    │   └── panel.ts            ← WebviewPanel host, WebSocket client, message relay
    ├── webview/
    │   └── index.html          ← xterm.js + xterm-addon-fit + xterm-addon-web-links
    ├── package.json            ← "browser": "./dist/extension.js" (web extension entry)
    ├── tsconfig.json
    └── webpack.config.js
```

## Component Details

### npm package (`npm/`)

**`bin/vsterm.js`**
- Detects `process.platform` and `process.arch`
- Resolves the matching binary from `binaries/`
- Execs it via `child_process.execFileSync` (or spawns it for `vsterm start`)
- Supports subcommands: `vsterm` (start foreground), `vsterm start` (start as service), `vsterm stop`, `vsterm status`

**`scripts/postinstall.js`** — runs automatically on `npm install -g vsterm`
- **macOS**: writes `~/Library/LaunchAgents/com.vsterm.daemon.plist`, calls `launchctl load`
- **Linux**: writes `~/.config/systemd/user/vsterm.service`, calls `systemctl --user enable --now vsterm`
- **Windows**: registers a Task Scheduler entry via `schtasks /create` set to trigger at logon
- Prints a confirmation: `vsterm daemon registered as a login service`

**`scripts/preuninstall.js`** — runs automatically on `npm uninstall -g vsterm`
- Reverses the service registration on all platforms
- Kills any running daemon process

### Daemon (`daemon/`)

**`main.go`**
- Binds `127.0.0.1:7007` only — never accessible from the network
- Serves `GET /` with a plain-text status page: `vsterm running`
- Upgrades `GET /ws` to WebSocket with no auth check
- Sets `Access-Control-Allow-Origin: https://vscode.dev` on all responses
- On start, prints: `vsterm started on 127.0.0.1:7007`

**`session.go`**
- `SessionManager` holds a `map[string]*Session` keyed by terminal ID
- Each `Session` owns: a `*os.File` (PTY master), a goroutine reading PTY output, and a `cols`/`rows` state
- `spawn(id, cols, rows)` → creates PTY, starts reader goroutine, registers session
- `input(id, data)` → writes raw bytes to PTY master
- `resize(id, cols, rows)` → calls `pty.Setsize`
- `kill(id)` → sends SIGKILL to the child process, cleans up

**`pty.go`**
- Thin wrapper around `github.com/creack/pty`
- `Spawn(cmd string, args []string, cols, rows uint16) (*os.File, *os.Process, error)`
- `Resize(pty *os.File, cols, rows uint16) error`

### Extension (`extension/`)

**`package.json`**
- `"browser": "./dist/extension.js"` — marks this as a web extension
- Contributes one command: `vsterm.open` — "Open Local Terminal"
- Does not declare `terminal` contribution points (would disqualify it as a web extension)

**`extension.ts`**
- Activates on command
- Calls `panel.ts` to create and show the WebviewPanel

**`panel.ts`**
- Creates a `vscode.WebviewPanel` with `retainContextWhenHidden: true`
- Loads `webview/index.html` as the panel content
- Opens a `WebSocket` to `ws://localhost:7007/ws`
- On WS `message`: forwards JSON to the webview via `panel.webview.postMessage`
- On webview `message`: forwards JSON to the WS (input, resize, spawn, kill)
- Handles reconnection with exponential backoff if the daemon is not running

**`webview/index.html`**
- Loads `xterm.js`, `xterm-addon-fit`, `xterm-addon-web-links` from bundled assets
- Creates one `Terminal` instance per spawned PTY session (tracked by `id`)
- Sends `{ type: "spawn", id, cols, rows }` on load
- Forwards `terminal.onData` → `postMessage` → extension → WS
- Renders incoming `output` messages via `terminal.write(atob(data))`
- Calls `fitAddon.fit()` on resize observer; sends `{ type: "resize", ... }` upstream
- Tab bar for switching between multiple open terminals

## Setup Flow

```
npm install -g vsterm
```

That's it. The `postinstall` script registers the daemon as a login service. It starts immediately and on every subsequent login.

Then in vscode.dev:

1. Install the `vsterm` extension from the VS Code Marketplace
2. Run `vsterm: Open Local Terminal` from the command palette

For one-shot use without global install:

```
npx vsterm
```

This starts the daemon in the foreground. The extension connects to it the same way.

If the daemon is not reachable when the command is invoked, the webview shows a "Daemon not reachable — run `npx vsterm` or `npm install -g vsterm`" message with a retry button.

## Security

- Daemon binds `127.0.0.1` only — not reachable from the local network or internet
- CORS is restricted to `https://vscode.dev` — no other origin can initiate a WebSocket connection
- The browser's same-origin policy ensures only pages served from `https://vscode.dev` can reach `ws://localhost`; arbitrary websites cannot

## vsterm vs Remote - Tunnels Comparison

| | vsterm | Remote - Tunnels |
|---|---|---|
| Microsoft account required | No | Yes |
| Traffic through MS servers | No | Yes |
| Works offline | Yes | No |
| Install | `npm install -g vsterm` | `code tunnel` + MS login |
| Always-on service | Yes (auto via postinstall) | Manual |
| One-shot use | `npx vsterm` | No equivalent |
| Daemon size | ~8 MB binary | ~300 MB VS Code Server |
| Multiple terminals | Yes (tabbed) | Yes |

## Future Extensions

- **TLS support** — generate a self-signed cert on first run so the connection is `wss://`; required if browsers tighten `localhost` exemptions
- **Port forwarding UI** — extend the protocol with `{ type: "forward", localPort, remotePort }` messages, shown as port badges in the extension
- **File transfer** — add `{ type: "upload" / "download" }` messages for dragging files between the browser and local filesystem
- **Multi-host** — allow the extension to store multiple `host:port` entries, switchable from a status bar item
