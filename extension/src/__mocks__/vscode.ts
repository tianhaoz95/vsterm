// Minimal vscode API mock for Jest tests

export const ViewColumn = { One: 1 };

export const Uri = {
  joinPath: (base: any, ...parts: string[]) => ({
    toString: () => [base.toString(), ...parts].join('/'),
    fsPath: [base.toString ? base.toString() : base, ...parts].join('/'),
  }),
  file: (p: string) => ({ toString: () => p, fsPath: p }),
};

export function createWebviewMock() {
  const listeners: ((msg: any) => void)[] = [];
  const posted: any[] = [];
  return {
    enableScripts: true,
    cspSource: 'https://mock.vscode-cdn.net',
    html: '',
    asWebviewUri: (uri: any) => ({ toString: () => 'webview://' + uri.toString() }),
    postMessage: jest.fn((msg: any) => { posted.push(msg); return Promise.resolve(); }),
    onDidReceiveMessage: jest.fn((listener: (msg: any) => void) => {
      listeners.push(listener);
      return { dispose: () => {} };
    }),
    _listeners: listeners,
    _posted: posted,
    _emit: (msg: any) => listeners.forEach(l => l(msg)),
  };
}

export function createPanelMock() {
  const webview = createWebviewMock();
  const disposeListeners: (() => void)[] = [];
  return {
    webview,
    reveal: jest.fn(),
    dispose: jest.fn(() => disposeListeners.forEach(l => l())),
    onDidDispose: jest.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: () => {} };
    }),
    _disposeListeners: disposeListeners,
  };
}

export const window = {
  createWebviewPanel: jest.fn(() => createPanelMock()),
  showInputBox: jest.fn(() => Promise.resolve('test-token')),
  showErrorMessage: jest.fn(),
};

export const commands = {
  registerCommand: jest.fn((id: string, cb: () => void) => ({ dispose: () => {} })),
  executeCommand: jest.fn(),
};

export const workspace = {};

export class EventEmitter {
  private listeners: ((e: any) => void)[] = [];
  event = (listener: (e: any) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(e: any) { this.listeners.forEach(l => l(e)); }
  dispose() {}
}
