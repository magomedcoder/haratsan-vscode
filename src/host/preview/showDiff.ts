import * as vscode from 'vscode';
import { showConfirmDialog } from '../ui/confirmDialog';

export const HARATSAN_COMMENT_SCHEME = 'haratsan-comment';

let sharedDiffProvider: DiffContentProvider | undefined;

export function getSharedDiffProvider(): DiffContentProvider | undefined {
	return sharedDiffProvider;
}

function languageIdFromUri(uri: vscode.Uri): string | undefined {
	const lang = new URLSearchParams(uri.query).get('lang');
	return lang?.trim() || undefined;
}

function diffTabUsesUri(tab: vscode.Tab, uri: vscode.Uri): boolean {
	const input = tab.input;
	if (!(input instanceof vscode.TabInputTextDiff)) {
		return false;
	}

	const key = uri.toString();
	return input.original.toString() === key || input.modified.toString() === key;
}

function isDiffOpenForUris(uris: vscode.Uri[]): boolean {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (uris.some((uri) => diffTabUsesUri(tab, uri))) {
				return true;
			}
		}
	}

	return false;
}

async function waitUntilDiffClosed(uris: vscode.Uri[]): Promise<void> {
	if (!isDiffOpenForUris(uris)) {
		return;
	}

	await new Promise<void>((resolve) => {
		const sub = vscode.window.tabGroups.onDidChangeTabs(() => {
			if (!isDiffOpenForUris(uris)) {
				sub.dispose();
				resolve();
			}
		});
	});
}

async function applyVirtualDocumentLanguage(doc: vscode.TextDocument): Promise<void> {
	if (doc.uri.scheme !== HARATSAN_COMMENT_SCHEME) {
		return;
	}

	const languageId = languageIdFromUri(doc.uri);
	if (!languageId || doc.languageId === languageId) {
		return;
	}

	try {
		await vscode.languages.setTextDocumentLanguage(doc, languageId);
	} catch {}
}

// Провайдер виртуальных документов для vscode.diff
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChange = this.emitter.event;

	// Записывает содержимое виртуального документа
	set(uri: vscode.Uri, content: string): void {
		this.contents.set(uri.toString(), content);
		this.emitter.fire(uri);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	// Удаляет временный документ из кэша
	clear(uri: vscode.Uri): void {
		this.contents.delete(uri.toString());
	}

	scheduleClearAfterDiffClosed(...uris: vscode.Uri[]): void {
		void waitUntilDiffClosed(uris).then(() => {
			for (const uri of uris) {
				this.clear(uri);
			}
		});
	}
}

export function registerDiffContentProvider(provider: DiffContentProvider): vscode.Disposable {
	sharedDiffProvider = provider;
	const languageSub = vscode.workspace.onDidOpenTextDocument((doc) => {
		void applyVirtualDocumentLanguage(doc);
	});

	for (const doc of vscode.workspace.textDocuments) {
		void applyVirtualDocumentLanguage(doc);
	}

	return vscode.Disposable.from(
		vscode.workspace.registerTextDocumentContentProvider(HARATSAN_COMMENT_SCHEME, provider),
		languageSub,
		{ dispose: () => {
			if (sharedDiffProvider === provider) {
				sharedDiffProvider = undefined;
			}
		} },
	);
}

function buildVirtualUri(side: 'original' | 'commented' | 'before', stamp: number, fileName: string, languageId: string): vscode.Uri {
	return vscode.Uri.from({
		scheme: HARATSAN_COMMENT_SCHEME,
		path: `/${side}/${stamp}/${fileName}`,
		query: `lang=${encodeURIComponent(languageId)}`,
	});
}

/**
 * Diff «до правок агента» <-> текущий файл при открытии изменённого файла.
 * Left = виртуальный снимок; right = живой URI на диске.
 */
export async function showAgentEditDiff(params: {
	provider: DiffContentProvider;
	fileUri: vscode.Uri;
	fileName: string;
	languageId?: string;
	original: string;
}): Promise<void> {
	const stamp = Date.now();
	let languageId = params.languageId?.trim();
	if (!languageId) {
		try {
			const doc = await vscode.workspace.openTextDocument(params.fileUri);
			languageId = doc.languageId;
		} catch {
			languageId = 'plaintext';
		}
	}

	const leftUri = buildVirtualUri('before', stamp, params.fileName, languageId || 'plaintext');
	params.provider.set(leftUri, params.original);

	const title = vscode.l10n.t('agent.editDiffTitle', params.fileName);
	await vscode.commands.executeCommand(
		'vscode.diff',
		leftUri,
		params.fileUri,
		title,
		{ 
			preview: true 
		},
	);

	params.provider.scheduleClearAfterDiffClosed(leftUri);
}

// Показывает diff исходник <-> с комментариями и спрашивает решение пользователя
export async function showCommentDiff(
	params: {
		provider: DiffContentProvider;
		fileName: string;
		languageId: string;
		original: string;
		commented: string;
		unsafeApply?: boolean;
	}
): Promise<'apply' | 'reject'> {
	const stamp = Date.now();
	const leftUri = buildVirtualUri('original', stamp, params.fileName, params.languageId);
	const rightUri = buildVirtualUri('commented', stamp, params.fileName, params.languageId);

	params.provider.set(leftUri, params.original);
	params.provider.set(rightUri, params.commented);

	await vscode.commands.executeCommand(
		'vscode.diff',
		leftUri,
		rightUri,
		vscode.l10n.t('comment.diffTitle', params.fileName),
		{ preview: false },
	);

	const choice = await showConfirmDialog({
		title: vscode.l10n.t('comment.applyCommentsQuestion'),
		detail: params.unsafeApply
			? vscode.l10n.t('comment.applyCommentsUnsafeDetail')
			: vscode.l10n.t('comment.applyCommentsDetail'),
		variant: 'binary',
		applyLabel: params.unsafeApply
			? vscode.l10n.t('comment.applyAnyway')
			: vscode.l10n.t('comment.apply'),
		rejectLabel: vscode.l10n.t('comment.reject'),
	});

	params.provider.scheduleClearAfterDiffClosed(leftUri, rightUri);

	return choice === 'apply' ? 'apply' : 'reject';
}
