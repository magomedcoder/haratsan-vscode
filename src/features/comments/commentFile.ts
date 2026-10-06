import * as vscode from 'vscode';
import { getActiveEditor, getFileFragment } from './context/selection';
import type { DiffContentProvider } from '../../host/preview/showDiff';
import { runCommentPipeline } from './runCommentPipeline';

export function registerCommentFile(diffProvider: DiffContentProvider): vscode.Disposable {
	return vscode.commands.registerCommand('haratsan.commentFile', async () => {
		const editor = getActiveEditor();
		if (!editor) {
			void vscode.window.showErrorMessage(vscode.l10n.t('comment.noActiveEditor'));
			return;
		}

		const fragment = getFileFragment(editor);
		if (!fragment) {
			void vscode.window.showErrorMessage(vscode.l10n.t('comment.emptyFile'));
			return;
		}

		await runCommentPipeline({ fragment, diffProvider });
	});
}
