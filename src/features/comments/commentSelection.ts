import * as vscode from 'vscode';
import { getActiveEditor, getSelectionFragment } from './context/selection';
import type { DiffContentProvider } from '../../host/preview/showDiff';
import { runCommentPipeline } from './runCommentPipeline';

// Регистрирует команду "Прокомментировать выделение"
export function registerCommentSelection(diffProvider: DiffContentProvider): vscode.Disposable {
	return vscode.commands.registerCommand('haratsan.commentSelection', async () => {
		const editor = getActiveEditor();
		if (!editor) {
			void vscode.window.showErrorMessage(vscode.l10n.t('comment.noActiveEditor'));
			return;
		}

		const fragment = getSelectionFragment(editor);
		if (!fragment) {
			void vscode.window.showErrorMessage(vscode.l10n.t('comment.selectCode'));
			return;
		}

		await runCommentPipeline({ fragment, diffProvider });
	});
}
