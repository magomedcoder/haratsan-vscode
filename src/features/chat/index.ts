import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { focusChatView } from './focusChat';
import { registerHunkCodeLens } from './hunkCodeLens';
import { CHAT_VIEW_ID, CHAT_VIEW_SIDEBAR_ID } from './ids';
import { getSettings } from '../../core/config/settings';
import { setConfirmHost } from '../../host/ui/confirmDialog';
import { ensureTerminalBufferListener } from './terminalBuffer';
import { listAgentWorktrees, removeAgentWorktree } from '../agent/worktree';
import { enableProject } from '../project/config';

export function registerChat(context: vscode.ExtensionContext): vscode.Disposable {
	// Одна сессия / один provider на panel + sidebar
	const provider = new ChatViewProvider(context);
	setConfirmHost((options) => provider.requestConfirm(options));

	const webviewOpts = { webviewOptions: { retainContextWhenHidden: true } };

	const disposable = vscode.Disposable.from(
		ensureTerminalBufferListener(),
		{
			dispose: () => setConfirmHost(undefined),
		},
		vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, webviewOpts),
		vscode.window.registerWebviewViewProvider(CHAT_VIEW_SIDEBAR_ID, provider, webviewOpts),
		registerHunkCodeLens(provider.getSession()),
		vscode.commands.registerCommand('haratsan.openChat', async () => {
			await focusChatView();
		}),
		vscode.commands.registerCommand('haratsan.openChatPanel', async () => {
			await focusChatView('panel');
		}),
		vscode.commands.registerCommand('haratsan.openChatSidebar', async () => {
			await focusChatView('sidebar');
		}),
		vscode.commands.registerCommand('haratsan.initProject', async () => {
			const folder = await enableProject();
			if (!folder) {
				void vscode.window.showWarningMessage(vscode.l10n.t('project.initNoWorkspace'));
				return;
			}
			
			void vscode.window.showInformationMessage(
				vscode.l10n.t('project.initDone', folder.name),
			);
		}),
		vscode.commands.registerCommand('haratsan.addSelectionToChat', async () => {
			await provider.getSession().addSelectionToChat();
		}),
		vscode.commands.registerCommand('haratsan.addToChat', async () => {
			await provider.getSession().addSelectionToChat();
		}),
		vscode.commands.registerCommand('haratsan.explainSelection', async () => {
			await provider.getSession().explainSelection();
		}),
		vscode.commands.registerCommand('haratsan.improveSelection', async () => {
			await provider.getSession().improveSelection();
		}),
		vscode.commands.registerCommand('haratsan.addTerminalToChat', async () => {
			await provider.getSession().addTerminalSelectionToChat();
		}),
		vscode.commands.registerCommand('haratsan.notebook.addCell', async () => {
			await provider.getSession().addNotebookCellToChat('add');
		}),
		vscode.commands.registerCommand('haratsan.notebook.explainCell', async () => {
			await provider.getSession().addNotebookCellToChat('explain');
		}),
		vscode.commands.registerCommand('haratsan.notebook.improveCell', async () => {
			await provider.getSession().addNotebookCellToChat('improve');
		}),
		vscode.commands.registerCommand('haratsan.notebook.generateCell', async () => {
			await provider.getSession().addNotebookCellToChat('generate');
		}),
		vscode.commands.registerCommand('haratsan.manageWorktrees', async () => {
			const items = await listAgentWorktrees();
			if (!items.length) {
				void vscode.window.showInformationMessage(vscode.l10n.t('chat.worktrees.empty'));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				items.map((w) => ({
					label: w.slug || w.path,
					description: w.branch || '',
					detail: w.path,
					path: w.path,
				})),
				{
					title: vscode.l10n.t('chat.worktrees.title')
				},
			);
			if (!picked) {
				return;
			}
			const action = await vscode.window.showQuickPick(
				[
					{
						label: vscode.l10n.t('chat.worktrees.open'),
						id: 'open' as const
					},
					{
						label: vscode.l10n.t('chat.worktrees.remove'),
						id: 'remove' as const
					},
				],
				{ title: picked.label },
			);
			if (!action) {
				return;
			}

			if (action.id === 'open') {
				const uri = vscode.Uri.file(picked.path);
				await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
				return;
			}
			
			const ok = await removeAgentWorktree(picked.path);
			void vscode.window.showInformationMessage(
				ok ? vscode.l10n.t('chat.worktrees.removed') : vscode.l10n.t('chat.worktrees.removeFailed'),
			);
		}),
	);

	// После регистрации: при одном месте показа - сразу сфокусировать
	const location = getSettings().chatViewLocation;
	if (location === 'sidebar') {
		void vscode.commands.executeCommand(`${CHAT_VIEW_SIDEBAR_ID}.focus`);
	} else if (location === 'panel') {
		void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
	}

	return disposable;
}
