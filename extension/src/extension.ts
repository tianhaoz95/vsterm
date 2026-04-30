import * as vscode from 'vscode';
import { openPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('vsterm.open', () => {
    openPanel(context);
  });
  context.subscriptions.push(disposable);
}

export function deactivate(): void {}
