import * as vscode from 'vscode';
import * as path from 'path';

const DAEMON_URL = 'ws://127.0.0.1:7007/ws';
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

let currentPanel: vscode.WebviewPanel | undefined;

export function _resetCurrentPanel(): void {
  currentPanel = undefined;
}

export function openPanel(context: vscode.ExtensionContext): void {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'vsterm',
    'vsterm',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'webview'),
      ],
    }
  );

  currentPanel = panel;
  panel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);

  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);

  const bridge = new WsBridge(panel);
  context.subscriptions.push({ dispose: () => bridge.dispose() });
}

class WsBridge {
  private ws: WebSocket | undefined;
  private attempt = 0;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly panel: vscode.WebviewPanel) {
    panel.webview.onDidReceiveMessage((msg: unknown) => this.onWebviewMsg(msg));
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    try {
      this.ws = new WebSocket(DAEMON_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.attempt = 0;
      this.panel.webview.postMessage({ type: '__connected' });
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.panel.webview.postMessage(msg);
      } catch { /* ignore malformed */ }
    };

    this.ws.onerror = () => { /* onclose will fire */ };

    this.ws.onclose = () => {
      if (this.disposed) return;
      this.panel.webview.postMessage({ type: 'daemon_disconnected' });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt++;
    this.panel.webview.postMessage({ type: 'reconnecting', attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onWebviewMsg(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch { /* ignore */ }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const vendorUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview', 'vendor', file));

  const xtermJs  = vendorUri('xterm.js');
  const xtermCss = vendorUri('xterm.css');
  const fitJs    = vendorUri('addon-fit.js');
  const linksJs  = vendorUri('addon-web-links.js');

  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}' ${webview.cspSource};
             connect-src ws://127.0.0.1:7007;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>vsterm</title>
  <link rel="stylesheet" href="${xtermCss}">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; background: #1e1e1e; color: #ccc; font-family: monospace; display: flex; flex-direction: column; }
    #tabbar { display: flex; align-items: center; background: #252526; border-bottom: 1px solid #3c3c3c; height: 35px; flex-shrink: 0; overflow-x: auto; }
    .tab { display: flex; align-items: center; padding: 0 12px; height: 100%; cursor: pointer; font-size: 13px; color: #969696; border-right: 1px solid #3c3c3c; white-space: nowrap; gap: 6px; }
    .tab.active { color: #fff; background: #1e1e1e; }
    .tab-close { opacity: 0.5; font-size: 16px; line-height: 1; }
    .tab-close:hover { opacity: 1; }
    #add-tab { padding: 0 12px; cursor: pointer; font-size: 18px; color: #969696; flex-shrink: 0; }
    #add-tab:hover { color: #fff; }
    #terminals { flex: 1; position: relative; overflow: hidden; }
    .term-wrap { position: absolute; inset: 0; padding: 4px; display: none; }
    .term-wrap.active { display: block; }
    #overlay { display: none; position: absolute; inset: 0; background: rgba(30,30,30,0.92); color: #ccc; flex-direction: column; align-items: center; justify-content: center; gap: 12px; font-size: 14px; z-index: 10; }
    #overlay.visible { display: flex; }
    #overlay button { padding: 6px 16px; background: #0e639c; color: #fff; border: none; cursor: pointer; border-radius: 2px; }
  </style>
</head>
<body>
  <div id="tabbar">
    <div id="add-tab" title="New terminal">+</div>
  </div>
  <div id="terminals">
    <div id="overlay">
      <span id="overlay-msg">Connecting to daemon…</span>
      <button id="retry-btn">Retry</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${xtermJs}"></script>
  <script nonce="${nonce}" src="${fitJs}"></script>
  <script nonce="${nonce}" src="${linksJs}"></script>
  <script nonce="${nonce}">
  (function() {
    const vscodeApi = acquireVsCodeApi();
    let tabCounter = 0;
    const tabs = {}; // id -> { terminal, fitAddon, wrap, tabEl }

    const tabbar   = document.getElementById('tabbar');
    const addBtn   = document.getElementById('add-tab');
    const termsCtr = document.getElementById('terminals');
    const overlay  = document.getElementById('overlay');
    const overlayMsg = document.getElementById('overlay-msg');
    const retryBtn = document.getElementById('retry-btn');

    function hideOverlay() { overlay.classList.remove('visible'); }
    function showOverlay(msg) { overlayMsg.textContent = msg; overlay.classList.add('visible'); }

    function makeTerminal(id) {
      const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'monospace' });
      const fitAddon = new FitAddon.FitAddon();
      const linksAddon = new WebLinksAddon.WebLinksAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(linksAddon);

      const wrap = document.createElement('div');
      wrap.className = 'term-wrap';
      wrap.dataset.id = id;
      termsCtr.appendChild(wrap);
      term.open(wrap);

      term.onData(data => vscodeApi.postMessage({ type: 'input', id, data }));

      const ro = new ResizeObserver(() => {
        fitAddon.fit();
        vscodeApi.postMessage({ type: 'resize', id, cols: term.cols, rows: term.rows });
      });
      ro.observe(wrap);

      return { term, fitAddon, wrap, ro };
    }

    function makeTab(id) {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.dataset.id = id;
      tab.innerHTML = 'Terminal ' + id.replace('t','') + ' <span class="tab-close" data-id="' + id + '">×</span>';
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          closeTab(e.target.dataset.id);
        } else {
          activateTab(id);
        }
      });
      tabbar.insertBefore(tab, addBtn);
      return tab;
    }

    function activateTab(id) {
      Object.values(tabs).forEach(t => {
        t.wrap.classList.remove('active');
        t.tabEl.classList.remove('active');
      });
      if (tabs[id]) {
        tabs[id].wrap.classList.add('active');
        tabs[id].tabEl.classList.add('active');
        tabs[id].fitAddon.fit();
      }
    }

    function closeTab(id) {
      vscodeApi.postMessage({ type: 'kill', id });
      if (tabs[id]) {
        tabs[id].term.dispose();
        tabs[id].ro.disconnect();
        tabs[id].wrap.remove();
        tabs[id].tabEl.remove();
        delete tabs[id];
      }
      const remaining = Object.keys(tabs);
      if (remaining.length > 0) {
        activateTab(remaining[remaining.length - 1]);
      }
    }

    function spawnTab() {
      tabCounter++;
      const id = 't' + tabCounter;
      const { term, fitAddon, wrap, ro } = makeTerminal(id);
      const tabEl = makeTab(id);
      tabs[id] = { term, fitAddon, wrap, tabEl, ro };
      activateTab(id);

      // measure after layout
      requestAnimationFrame(() => {
        fitAddon.fit();
        vscodeApi.postMessage({ type: 'spawn', id, cols: term.cols || 80, rows: term.rows || 24 });
      });
    }

    addBtn.addEventListener('click', spawnTab);
    retryBtn.addEventListener('click', () => {
      showOverlay('Reconnecting…');
      vscodeApi.postMessage({ type: '__retry' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'output': {
          if (tabs[msg.id]) {
            tabs[msg.id].term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
          }
          break;
        }
        case 'exit': {
          if (tabs[msg.id]) {
            tabs[msg.id].term.writeln('\\r\\n\\x1b[90m[Process exited with code ' + msg.code + ']\\x1b[0m');
          }
          break;
        }
        case 'error': {
          if (tabs[msg.id]) {
            tabs[msg.id].term.writeln('\\r\\n\\x1b[31m[Error: ' + msg.msg + ']\\x1b[0m');
          }
          break;
        }
        case 'daemon_disconnected': {
          showOverlay('Daemon not reachable — run \`npx vsterm\` or \`npm install -g vsterm\`');
          break;
        }
        case 'reconnecting': {
          showOverlay('Reconnecting… (attempt ' + msg.attempt + ')');
          break;
        }
        case '__connected': {
          hideOverlay();
          if (Object.keys(tabs).length === 0) spawnTab();
          break;
        }
      }
    });

    // start with overlay until WS connects
    showOverlay('Connecting to daemon…');
  })();
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
