# vsterm

A local terminal for [vscode.dev](https://vscode.dev). Runs a tiny daemon on your machine and connects to it from the browser via a VS Code web extension.

```
npm install -g vsterm          # installs daemon + registers as login service
```

Then in vscode.dev: install the **vsterm** extension → run `vsterm: Open Local Terminal` from the command palette.

---

## Why this exists

vscode.dev runs entirely in the browser. Browsers cannot spawn processes, open PTYs, or access the OS — so there is no built-in terminal. Microsoft's Remote Tunnels extension solves this by routing everything through Microsoft's servers and requires a Microsoft account. vsterm solves it without either: a small local daemon exposes your shell over WebSocket on `127.0.0.1:7007`, and the extension connects directly.

| | vsterm | Remote Tunnels |
|---|---|---|
| Microsoft account | No | Yes |
| Traffic through MS servers | No | Yes |
| Works offline | Yes | No |
| Daemon size | ~8 MB binary | ~300 MB VS Code Server |
| Install | `npm install -g vsterm` | `code tunnel` + MS login |
| Auto-start on login | Yes | Manual |
| One-shot use | `npx vsterm` | No equivalent |

---

## How it works

```
 Browser (vscode.dev)
 ┌──────────────────────────────────────────┐
 │  vsterm extension                        │
 │  • xterm.js terminal in a WebviewPanel   │
 │  • WebSocket → ws://127.0.0.1:7007/ws   │
 └──────────────────────┬───────────────────┘
                        │ WebSocket
                        ▼
 Local machine
 ┌──────────────────────────────────────────┐
 │  vsterm daemon  (~8 MB Go binary)        │
 │  • Spawns PTY shells via creack/pty      │
 │  • Multiplexes N terminals per tab       │
 │  • Bound to 127.0.0.1 only              │
 └──────────────────────────────────────────┘
```

The extension lives in the browser. The daemon lives on your machine. They speak a simple JSON protocol over WebSocket — `spawn`, `input`, `resize`, `kill` going up; `output`, `exit`, `error` coming back. PTY output is base64-encoded to safely carry binary escape sequences.

---

## Getting started

### Prerequisites

- Node.js 18+
- macOS, Linux, or Windows (x64 or arm64)

### Install

```sh
npm install -g vsterm
```

The `postinstall` script automatically registers the daemon as a login service so it starts now and on every subsequent login:

- **macOS** — `~/Library/LaunchAgents/com.vsterm.daemon.plist` loaded via `launchctl`
- **Linux** — `~/.config/systemd/user/vsterm.service` enabled via `systemctl --user`
- **Windows** — Task Scheduler entry triggered at logon

Check the daemon is running:

```sh
vsterm status   # → "running"
```

### Install the VS Code extension

Once vsterm is published to the Marketplace, install it from within vscode.dev:

1. Open [vscode.dev](https://vscode.dev) in your browser
2. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **vsterm** and install it

Until then, or during development, install via `.vsix` — see [Installing the extension in vscode.dev (development)](#installing-the-extension-in-vscodedev-development) below.

### Open a terminal

Run `vsterm: Open Local Terminal` from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

A terminal panel opens immediately. Multiple terminals are supported via the tab bar — click **+** to add more, **×** to close one.

### One-shot use (no global install)

If you just want to try it without installing:

```sh
npx vsterm
```

This starts the daemon in the foreground. The extension connects to it the same way. Ctrl+C stops it.

### Uninstall

```sh
npm uninstall -g vsterm
```

The `preuninstall` script stops the daemon and removes the login service entry.

---

## Session persistence

The daemon itself does not persist terminal state across reconnects — when the browser tab closes, PTY sessions are cleaned up. To persist a working session across reconnects, use **tmux**:

```sh
tmux           # start a tmux session inside the terminal
# ... do your work ...
```

When you reconnect, run `tmux attach` in a new terminal tab to resume exactly where you left off — running processes, shell history, and all.

---

## Repository layout

```
vsterm/
├── daemon/                     Go source for the local daemon
│   ├── main.go                 HTTP server, WebSocket upgrade, message dispatch
│   ├── session.go              Terminal session registry (one goroutine per PTY)
│   ├── pty.go                  PTY spawn / resize / kill (creack/pty)
│   ├── *_test.go               20 Go tests
│   └── go.mod
│
├── npm/                        npm package (published as "vsterm")
│   ├── bin/vsterm.js           CLI entry point — platform binary selector
│   ├── scripts/postinstall.js  Login service registration (launchd/systemd/schtasks)
│   ├── scripts/preuninstall.js Service removal + daemon kill
│   ├── binaries/               Pre-built Go binaries per platform (git-ignored until release)
│   └── __tests__/              14 Jest tests
│
├── extension/                  VS Code web extension
│   ├── src/extension.ts        Command registration
│   ├── src/panel.ts            WebviewPanel + WebSocket bridge + reconnect logic
│   ├── webview/vendor/         xterm.js assets (copied by webpack)
│   ├── src/__tests__/          18 Jest tests
│   └── webpack.config.js       Bundles to dist/extension.js (target: webworker)
│
├── design/
│   ├── DESIGN.md               Architecture and design decisions
│   └── PLAN.md                 Implementation plan with verifiable criteria
│
└── Makefile
```

---

## Wire protocol

All messages are JSON over a single WebSocket connection. PTY output is base64-encoded.

**Client → Daemon**

```json
{ "type": "spawn",  "id": "t1", "cols": 220, "rows": 50 }
{ "type": "input",  "id": "t1", "data": "ls -la\r" }
{ "type": "resize", "id": "t1", "cols": 180, "rows": 40 }
{ "type": "kill",   "id": "t1" }
```

**Daemon → Client**

```json
{ "type": "output", "id": "t1", "data": "<base64 PTY bytes>" }
{ "type": "exit",   "id": "t1", "code": 0 }
{ "type": "error",  "id": "t1", "msg": "unknown session" }
```

---

## Security

- The daemon binds `127.0.0.1` only — never reachable from the network
- CORS is restricted to `https://vscode.dev`; arbitrary websites cannot connect
- The browser's same-origin policy ensures only vscode.dev pages can reach `ws://localhost`
- No authentication token is required — any local process can already reach localhost

---

## Local development and testing

### Run all tests

```sh
make test
```

This runs all three test suites in sequence.

### Daemon (Go)

```sh
cd daemon
go mod tidy          # fetch dependencies
go test -v ./...     # run 20 tests
go run .             # start daemon in foreground (listens on 127.0.0.1:7007)
```

Verify the daemon manually:

```sh
curl http://127.0.0.1:7007/          # → "vsterm running"
# With websocat installed:
websocat ws://127.0.0.1:7007/ws
{"type":"spawn","id":"t1","cols":80,"rows":24}
{"type":"input","id":"t1","data":"echo hello\r"}
```

### npm package

```sh
cd npm
npm install
npm test             # run 14 Jest tests
```

To test `vsterm status` / `vsterm stop` manually, first build the daemon binary:

```sh
make build           # outputs npm/binaries/vsterm-<os>-<arch>
node npm/bin/vsterm.js status
```

To skip service registration during development (avoids touching launchd/systemd):

```sh
VSTERM_SKIP_SERVICE=1 node npm/scripts/postinstall.js
```

### Extension

```sh
cd extension
npm install
npm test             # run 18 Jest tests (mocked vscode API)
npm run build        # production webpack bundle → dist/extension.js
npm run build:dev    # development bundle with source maps
```

To test in VS Code desktop (fastest iteration, supports live reload via `F5`):

```sh
code --extensionDevelopmentPath=$(pwd)/extension
```

To test in a real browser environment using `serve-web`:

```sh
npm run serve    # builds + starts http://localhost:5000
```

See [Testing the extension in vscode.dev (development)](#testing-the-extension-in-vscodedev-development) for the full workflow.

---

## Testing the extension in vscode.dev (development)

vscode.dev blocks all local extension installation paths — "Install Extension from Location" and `.vsix` drag-and-drop both require a backend server that doesn't exist in a plain browser tab. The correct dev loop for web extensions is `vsce serve-web`, which starts a local vscode.dev instance that loads your extension directly from disk.

### Start the dev server

```sh
cd extension
npm install
npm run serve
```

This builds the extension in development mode and starts a local vscode.dev instance on port 5000. Open it in your browser:

```
http://localhost:5000
```

You get a full vscode.dev environment with the vsterm extension already loaded. No installation step, no `.vsix`, no drag-and-drop.

### Connect to the daemon

In a separate terminal, start the daemon:

```sh
cd daemon && go run .
# or, after make build:
npx vsterm
```

Then in the browser at `http://localhost:5000`, open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → `vsterm: Open Local Terminal`. A shell prompt should appear.

### Iterating on changes

`npm run serve` does a single build then starts the server — it does not watch for changes. After editing source files, stop the server, re-run `npm run serve`, and reload the browser tab.

For a faster inner loop, use `build:dev` with watch mode in one terminal and let the server keep running in another:

```sh
# terminal 1 — rebuild on every save
cd extension && npx webpack --mode development --watch

# terminal 2 — keep the server running
cd extension && npx @vscode/test-web --extensionDevelopmentPath=. --port 5000 --browser none
```

Reload the browser tab after each rebuild to pick up the changes.

### VS Code desktop (fastest iteration)

`serve-web` reloads are manual. For the tightest feedback loop during development, use VS Code desktop which supports live extension reload via `F5`:

```sh
code --extensionDevelopmentPath=$(pwd)/extension
```

Run `vsterm: Open Local Terminal` from the command palette with the daemon running. Use `serve-web` / `http://localhost:5000` for final verification that the extension works correctly in the actual browser environment.

> **Note:** "Install Extension from Location" and `.vsix` drag-and-drop both show "No servers" or "Local extension management server is not found" in a plain vscode.dev tab. This is a vscode.dev constraint — those paths require a remote backend (Codespace, Tunnel, or VS Code Server). `serve-web` is the correct workaround.

### Build all platform binaries

```sh
make build-all
```

Outputs to `npm/binaries/`:

```
vsterm-darwin-arm64
vsterm-darwin-x64
vsterm-linux-arm64
vsterm-linux-x64
vsterm-win32-x64.exe
```

Each binary should be under 15 MB.

---

## Contributing

1. Fork and clone the repo
2. Make your changes with tests
3. Run `make test` — all 52 tests must pass
4. Open a pull request

### Adding a new protocol message type

1. Add the message struct fields to `wsMsg` in `daemon/session.go`
2. Handle the new `type` in the dispatch `switch` in `daemon/main.go`
3. Send/receive it in `extension/src/panel.ts`
4. Handle it in the `window.addEventListener("message", ...)` block in `webview/index.html` (inlined in `panel.ts`)
5. Add tests in `daemon/server_test.go` and `extension/src/__tests__/panel.test.ts`

---

## License

MIT
