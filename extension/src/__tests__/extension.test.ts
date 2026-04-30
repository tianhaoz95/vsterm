import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';

describe('extension activation', () => {
  let context: any;

  beforeEach(() => {
    jest.clearAllMocks();
    context = {
      subscriptions: [],
      extensionUri: vscode.Uri.file('/mock/extension'),
      secrets: { get: jest.fn(), store: jest.fn() },
    };
  });

  test('registers vsterm.open command', () => {
    activate(context);
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      'vsterm.open',
      expect.any(Function)
    );
  });

  test('pushes disposable to subscriptions', () => {
    activate(context);
    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  test('deactivate does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
