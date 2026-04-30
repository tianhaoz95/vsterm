// Mock WebSocket globally BEFORE any imports
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; }

  static instances: MockWebSocket[] = [];
  static reset() { MockWebSocket.instances = []; }
  static latest(): MockWebSocket { return MockWebSocket.instances[MockWebSocket.instances.length - 1]; }
}
(global as any).WebSocket = MockWebSocket;

import * as vscode from 'vscode';
import { openPanel, _resetCurrentPanel } from '../panel';

function getLastPanel() {
  const calls = (vscode.window.createWebviewPanel as jest.Mock).mock.results;
  if (calls.length === 0) throw new Error('createWebviewPanel was never called');
  return calls[calls.length - 1].value;
}

describe('openPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockWebSocket.reset();
    _resetCurrentPanel();
  });

  test('creates a webview panel', () => {
    openPanel({
      subscriptions: [],
      extensionUri: vscode.Uri.file('/mock/extension'),
    } as any);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'vsterm', 'vsterm', vscode.ViewColumn.One,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true })
    );
  });

  test('sets webview HTML with DOCTYPE', () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    const panel = getLastPanel();
    expect(panel.webview.html).toContain('<!DOCTYPE html>');
  });

  test('HTML contains xterm asset references', () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    const panel = getLastPanel();
    expect(panel.webview.html).toContain('xterm.js');
    expect(panel.webview.html).toContain('addon-fit.js');
    expect(panel.webview.html).toContain('addon-web-links.js');
  });

  test('HTML contains CSP with daemon connect-src', () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    const panel = getLastPanel();
    expect(panel.webview.html).toContain('Content-Security-Policy');
    expect(panel.webview.html).toContain('ws://127.0.0.1:7007');
  });

  test('connects WebSocket to daemon URL', async () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    await new Promise(r => setTimeout(r, 10));
    expect(MockWebSocket.instances.length).toBe(1);
    expect(MockWebSocket.latest().url).toBe('ws://127.0.0.1:7007/ws');
  });

  test('forwards WS message to webview', async () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    await new Promise(r => setTimeout(r, 10));
    const ws = MockWebSocket.latest();
    const panel = getLastPanel();

    const msg = { type: 'output', id: 't1', data: 'aGVsbG8=' };
    ws.onmessage?.({ data: JSON.stringify(msg) });

    expect(panel.webview.postMessage).toHaveBeenCalledWith(msg);
  });

  test('posts __connected to webview on WS open', async () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    await new Promise(r => setTimeout(r, 10));
    const panel = getLastPanel();
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: '__connected' });
  });

  test('ignores malformed WS messages', async () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    await new Promise(r => setTimeout(r, 10));
    const ws = MockWebSocket.latest();
    const panel = getLastPanel();
    const callsBefore = (panel.webview.postMessage as jest.Mock).mock.calls.length;

    expect(() => ws.onmessage?.({ data: 'not json{{' })).not.toThrow();
    // no additional postMessage beyond the __connected already sent on open
    expect((panel.webview.postMessage as jest.Mock).mock.calls.length).toBe(callsBefore);
  });

  test('posts daemon_disconnected on WS close', async () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    await new Promise(r => setTimeout(r, 10));
    const ws = MockWebSocket.latest();
    const panel = getLastPanel();

    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose?.();

    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'daemon_disconnected' })
    );
  });

  test('posts reconnecting message on disconnect', async () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    await new Promise(r => setTimeout(r, 10));
    const ws = MockWebSocket.latest();
    const panel = getLastPanel();

    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose?.();

    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reconnecting', attempt: 1 })
    );
  });

  test('sends webview message to WS when open', async () => {
    const ctx = { subscriptions: [] as any[], extensionUri: vscode.Uri.file('/mock') } as any;
    openPanel(ctx);
    await new Promise(r => setTimeout(r, 10));
    const ws = MockWebSocket.latest();
    const panel = getLastPanel();

    const inputMsg = { type: 'input', id: 't1', data: 'ls\r' };
    const msgListener = (panel.webview.onDidReceiveMessage as jest.Mock).mock.calls[0]?.[0];
    expect(msgListener).toBeDefined();
    msgListener(inputMsg);

    expect(ws.sent).toContain(JSON.stringify(inputMsg));
  });

  test('does not forward to WS when closed', async () => {
    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    await new Promise(r => setTimeout(r, 10));
    const ws = MockWebSocket.latest();
    ws.readyState = MockWebSocket.CLOSED;

    const panel = getLastPanel();
    const msgListener = (panel.webview.onDidReceiveMessage as jest.Mock).mock.calls[0]?.[0];
    msgListener?.({ type: 'input', id: 't1', data: 'x' });

    expect(ws.sent).toHaveLength(0);
  });

  test('closes WS when subscription is disposed', async () => {
    const ctx = { subscriptions: [] as any[], extensionUri: vscode.Uri.file('/mock') } as any;
    openPanel(ctx);
    await new Promise(r => setTimeout(r, 10));
    const ws = MockWebSocket.latest();

    const bridgeDisposable = ctx.subscriptions.find((s: any) => typeof s.dispose === 'function');
    expect(bridgeDisposable).toBeDefined();
    bridgeDisposable.dispose();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  test('second call reveals existing panel instead of creating new', async () => {
    const ctx = { subscriptions: [] as any[], extensionUri: vscode.Uri.file('/mock') } as any;
    openPanel(ctx);
    await new Promise(r => setTimeout(r, 10));
    const panel = getLastPanel();

    openPanel(ctx);
    expect(panel.reveal).toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  test('new panel can be created after dispose', async () => {
    const ctx = { subscriptions: [] as any[], extensionUri: vscode.Uri.file('/mock') } as any;
    openPanel(ctx);
    await new Promise(r => setTimeout(r, 10));
    const panel = getLastPanel();

    // simulate panel being disposed (fires onDidDispose)
    panel.dispose();
    jest.clearAllMocks();
    MockWebSocket.reset();

    // now openPanel should create fresh
    openPanel(ctx);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
  });
});

describe('HTML nonce uniqueness', () => {
  test('two separate openPanel calls produce different nonces', () => {
    _resetCurrentPanel();
    jest.clearAllMocks();

    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    const html1 = getLastPanel().webview.html;

    _resetCurrentPanel();
    jest.clearAllMocks();

    openPanel({ subscriptions: [], extensionUri: vscode.Uri.file('/mock') } as any);
    const html2 = getLastPanel().webview.html;

    const n1 = html1.match(/nonce-([A-Za-z0-9]+)/)?.[1];
    const n2 = html2.match(/nonce-([A-Za-z0-9]+)/)?.[1];
    expect(n1).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(n2).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(n1).not.toBe(n2);
  });
});
