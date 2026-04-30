# vsterm Implementation Plan

Each task has a verifiable completion criterion. Subtasks are ordered; later ones depend on earlier ones within the same task.

---

## Task 1 — Scaffold repository structure

### 1.1 Initialize Go module
- Create `daemon/` directory
- Run `go mod init github.com/yourname/vsterm`
- **Verify:** `daemon/go.mod` exists and contains `module github.com/yourname/vsterm`

### 1.2 Initialize npm package
- Create `npm/` directory with `bin/`, `scripts/`, `binaries/` subdirectories
- Create `npm/package.json` with `name: "vsterm"`, `bin: { "vsterm": "./bin/vsterm.js" }`, `scripts: { postinstall, preuninstall }`
- **Verify:** `npm pack` in `npm/` completes without errors; `vsterm` appears in the `bin` field

### 1.3 Initialize extension package
- Create `extension/` directory with `src/`, `webview/` subdirectories
- Create `extension/package.json` with name `vsterm`, `"browser": "./dist/extension.js"`, and command contribution `vsterm.open`
- Create `extension/tsconfig.json` targeting ES2020, `lib: ["ES2020", "dom"]`
- Create `extension/webpack.config.js` with `target: "webworker"` (required for web extensions)
- **Verify:** `npm install` in `extension/` completes without errors; `npx webpack --dry-run` resolves entry point

---

## Task 2 — Daemon: HTTP and WebSocket server

### 2.1 Add dependencies
- `go get github.com/gorilla/websocket`
- `go get github.com/creack/pty`
- **Verify:** Both appear in `daemon/go.mod` and `daemon/go.sum`

### 2.2 Implement HTTP server
- Bind `net.Listen("tcp", "127.0.0.1:7007")`
- `GET /` returns a plain-text status page: `vsterm running`
- On start, print to stdout: `vsterm started on 127.0.0.1:7007`
- **Verify:** `curl http://127.0.0.1:7007/` returns status 200 with status text

### 2.3 Implement WebSocket upgrade
- `GET /ws` — upgrade with `gorilla/websocket` upgrader; set `CheckOrigin` to allow `https://vscode.dev` and `http://localhost` (for local dev)
- Set CORS header `Access-Control-Allow-Origin: https://vscode.dev` on all responses
- **Verify:** `websocat ws://127.0.0.1:7007/ws` successfully connects (101 Switching Protocols)

---

## Task 3 — Daemon: PTY management

### 3.1 Implement `pty.go`
- `Spawn(cols, rows uint16) (*os.File, *exec.Cmd, error)` — detect user's shell from `$SHELL`, fall back to `/bin/sh`; start via `pty.StartWithSize`
- `Resize(ptmx *os.File, cols, rows uint16) error` — call `pty.Setsize`
- **Verify:** Unit test: spawn a shell, write `echo hello\r`, read output within 1s, output contains `hello`

### 3.2 Implement `session.go`
- `Session` struct: `id string`, `ptmx *os.File`, `cmd *exec.Cmd`, `send chan []byte` (outbound to WS)
- `SessionManager` struct: `mu sync.Mutex`, `sessions map[string]*Session`
- `Spawn(id string, cols, rows uint16, send chan []byte) error` — create PTY, start reader goroutine that reads PTY output in a loop and pushes base64-encoded `output` JSON onto `send`; register session
- `Input(id, data string) error` — write decoded bytes to PTY master
- `Resize(id string, cols, rows uint16) error`
- `Kill(id string) error` — send SIGKILL, close PTY, delete from map
- Reader goroutine: on PTY read error (process exited), push `exit` message onto `send`, remove session
- **Verify:** Integration test: spawn session, send `echo ping\r` via `Input`, receive `output` message containing `ping` within 2s

---

## Task 4 — Daemon: message dispatch loop

### 4.1 Implement per-connection read/write loops in `main.go`
- On WebSocket connect: create `send chan []byte` (buffered, 256); start write goroutine that reads from channel and calls `ws.WriteMessage`
- Read loop: `ws.ReadMessage` in a loop; unmarshal JSON; dispatch to `SessionManager` based on `type` field (`spawn`, `input`, `resize`, `kill`)
- On read error or close: call `manager.KillAll(connID)` to clean up all sessions for this connection; exit goroutines
- **Verify:**
  - Connect with `websocat ws://127.0.0.1:7007/ws`
  - Send `{"type":"spawn","id":"t1","cols":80,"rows":24}` → receive no error
  - Send `{"type":"input","id":"t1","data":"echo vsterm\r"}` → receive `{"type":"output","id":"t1","data":"<base64>"}` where decoded data contains `vsterm`
  - Send `{"type":"kill","id":"t1"}` → receive `{"type":"exit","id":"t1","code":0}`

### 4.2 Handle unknown session IDs gracefully
- If `input`/`resize`/`kill` references unknown `id`, send `{"type":"error","id":"...","msg":"unknown session"}` — do not crash
- **Verify:** Send `{"type":"input","id":"nonexistent","data":"x"}` → receive error message; connection stays open

---

## Task 5 — Daemon: build and npm packaging

### 5.1 Add `Makefile`
- `make build` — `go build -o npm/binaries/vsterm-$(GOOS)-$(GOARCH) ./daemon`
- `make build-all` — cross-compile for `darwin/arm64`, `darwin/amd64`, `linux/arm64`, `linux/amd64`, `windows/amd64`; output to `npm/binaries/`
- **Verify:** `make build-all` produces all five binaries in `npm/binaries/`; each is executable

### 5.2 Implement `npm/bin/vsterm.js`
- Detects `process.platform` + `process.arch`, maps to the correct binary name in `../binaries/`
- If binary not found for current platform, prints a clear error and exits 1
- Supports subcommands: `vsterm` / `vsterm start` (start foreground), `vsterm stop`, `vsterm status`
- **Verify:** `node npm/bin/vsterm.js status` prints `running` or `not running` without errors on macOS, Linux, and Windows

### 5.3 Implement `npm/scripts/postinstall.js`
- Detects platform and registers the daemon as a login service:
  - **macOS**: writes `~/Library/LaunchAgents/com.vsterm.daemon.plist`; calls `launchctl load`
  - **Linux**: writes `~/.config/systemd/user/vsterm.service`; calls `systemctl --user enable --now vsterm`
  - **Windows**: calls `schtasks /create` with a logon trigger pointing to the binary
- Prints: `vsterm daemon registered as a login service`
- **Verify:** After `npm install -g vsterm`, the service entry exists and `vsterm status` reports `running`

### 5.4 Implement `npm/scripts/preuninstall.js`
- Reverses service registration: unloads/disables/deletes the service entry on each platform
- Kills any running daemon process
- **Verify:** After `npm uninstall -g vsterm`, service entry is gone; port 7007 is no longer listening

### 5.5 Verify binary size
- **Verify:** Each binary in `npm/binaries/` is under 15 MB

---

## Task 6 — Extension: web extension scaffold

### 6.1 Configure webpack for web extension
- `webpack.config.js`: `target: "webworker"`, entry `./src/extension.ts`, output `./dist/extension.js`
- Externals: `{ vscode: "commonjs vscode" }`
- **Verify:** `npx webpack` produces `dist/extension.js` with no errors

### 6.2 Implement `extension.ts` activation
- `activate(context)`: register command `vsterm.open`
- Command handler: call `openPanel(context)`
- **Verify:** In VS Code desktop (for dev), run command → panel opens immediately with no prompts

---

## Task 7 — Extension: WebviewPanel and WebSocket bridge

### 7.1 Implement `panel.ts` — panel creation
- `openPanel(context)`: create `vscode.WebviewPanel` with `retainContextWhenHidden: true`, `enableScripts: true`
- Load `webview/index.html` as panel HTML (inline via `panel.webview.asWebviewUri` for assets)
- **Verify:** Panel opens and displays the HTML content without CSP errors in the developer console

### 7.2 Implement `panel.ts` — WebSocket client
- Open `WebSocket("ws://127.0.0.1:7007/ws")` inside the extension host (not the webview)
- On `ws.onmessage`: `panel.webview.postMessage(JSON.parse(event.data))`
- On `panel.webview.onDidReceiveMessage`: `ws.send(JSON.stringify(msg))`
- On `ws.onerror` / `ws.onclose`: post `{ type: "daemon_disconnected" }` to webview
- **Verify:** With daemon running, open panel → webview receives `output` messages after spawning a terminal; typing in webview sends `input` messages visible in daemon logs

### 7.3 Implement reconnection with exponential backoff
- On disconnect: wait 1s, 2s, 4s, 8s (cap at 30s) before each reconnect attempt
- Post `{ type: "reconnecting", attempt: N }` to webview so UI can show status
- **Verify:** Stop daemon while panel is open → webview shows reconnecting status; restart daemon → connection restores within one backoff cycle

---

## Task 8 — Webview: terminal UI

### 8.1 Bundle xterm.js assets
- Add `xterm`, `xterm-addon-fit`, `xterm-addon-web-links` to `extension/package.json` dependencies
- Copy distribution files (`xterm.js`, `xterm.css`, addon files) into `extension/webview/vendor/` as part of webpack build
- Reference them with relative paths in `index.html`
- **Verify:** `index.html` loads in a browser standalone (open as file) without 404s for assets

### 8.2 Implement terminal lifecycle in `index.html`
- On load: acquire VS Code webview API via `acquireVsCodeApi()`; send `{ type: "spawn", id: "t1", cols, rows }` using measured terminal dimensions
- Create `xterm.Terminal` with `cursorBlink: true`; attach `FitAddon`, `WebLinksAddon`; open into `#terminal` div
- `terminal.onData(data => vscode.postMessage({ type: "input", id: "t1", data }))`
- On `window.addEventListener("message", ...)`: handle `output` (write decoded base64), `exit` (show "Process exited" banner), `daemon_disconnected` (show overlay with message "Daemon not reachable — run `npx vsterm` or `npm install -g vsterm`"), `reconnecting` (show spinner with attempt count)
- `ResizeObserver` on container: call `fitAddon.fit()`; post `{ type: "resize", id: "t1", cols, rows }` upstream
- **Verify:** Open panel with daemon running → shell prompt appears; type `ls` + Enter → directory listing renders with correct colors and formatting

### 8.3 Implement tab bar for multiple terminals
- "+" button in tab bar: post `{ type: "spawn", id: "t<N>", cols, rows }` for next ID; create new `xterm.Terminal`; add tab
- Tab click: hide current terminal div, show selected; update active tab style
- Tab close ("×"): post `{ type: "kill", id }`, dispose `xterm.Terminal`, remove tab; switch to adjacent tab
- **Verify:** Open two terminals; run different commands in each; switch tabs — each shows its own independent output; closing one tab does not affect the other

---

## Task 9 — Integration testing

### 9.1 End-to-end smoke test (global install)
- Run `npm install -g vsterm`
- **Verify:** `vsterm status` reports `running`; daemon started automatically by the service
- Open vscode.dev, install the vsterm extension, run `vsterm: Open Local Terminal`
- **Verify:** Terminal opens immediately with no prompts; `echo $SHELL` returns a valid shell path; `pwd` returns a directory; Ctrl+C cancels a running `sleep 10`

### 9.2 One-shot npx test
- Ensure no global install; run `npx vsterm` in a terminal
- Open vscode.dev, run `vsterm: Open Local Terminal`
- **Verify:** Terminal connects to the foreground daemon process; killing the `npx vsterm` process causes the reconnecting overlay to appear

### 9.3 Reconnection test
- With panel open and a shell running, kill the daemon process
- **Verify:** Webview shows reconnecting overlay within 2s
- Restart daemon
- **Verify:** Connection restores; new shell spawns on reconnect; no crash or hung goroutines in daemon

### 9.4 Multiple-connection test
- Open two separate browser tabs of vscode.dev both connecting to the same daemon
- **Verify:** Each gets independent sessions; killing all terminals in one tab does not affect the other; daemon logs show two separate connection goroutines

### 9.5 tmux persistence walkthrough
- In terminal tab, run `tmux`; start a long-running process (e.g. `top`)
- Close vscode.dev tab entirely
- Reopen vscode.dev, open vsterm, spawn new terminal; run `tmux attach`
- **Verify:** `top` is still running in the tmux session — no daemon changes needed to support this

---

## Task 10 — Security hardening

### 10.1 Verify localhost-only binding
- **Verify:** Attempting to connect from another machine on the LAN to port 7007 → connection refused

### 10.2 Verify CORS restriction
- **Verify:** `curl -H "Origin: https://evil.com" http://127.0.0.1:7007/ws` → response does not include `Access-Control-Allow-Origin: https://evil.com`

---

## Completion Checklist

- [ ] `make build-all` produces all five platform binaries under 15 MB each
- [ ] `npm install -g vsterm` starts the daemon as a login service automatically
- [ ] `npx vsterm` starts the daemon in the foreground without a global install
- [ ] `npm uninstall -g vsterm` cleanly removes the service and stops the daemon
- [ ] `npx webpack` in `extension/` produces `dist/extension.js` with no errors
- [ ] Shell prompt appears in webview within 3s of opening panel with no prompts
- [ ] Keyboard input reaches the PTY; output renders correctly including ANSI colors
- [ ] Terminal resize (drag panel edge) propagates to PTY — `tput cols` returns updated width
- [ ] Multiple terminal tabs work independently
- [ ] Reconnection overlay shows on daemon stop; terminal restores on daemon restart
- [ ] `tmux attach` after reconnect restores user session (no daemon changes needed)
- [ ] No goroutine leak after connection close (verify with `pprof` or log goroutine count)
