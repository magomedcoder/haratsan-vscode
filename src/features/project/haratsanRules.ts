import * as vscode from 'vscode';

export const HARATSAN_RULES_RELATIVE = '.haratsanrules';
export const MAX_HARATSAN_RULES_CHARS = 12_000;

export function normalizeHaratsanRulesText(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}

	if (trimmed.length <= MAX_HARATSAN_RULES_CHARS) {
		return trimmed;
	}

	return `${trimmed.slice(0, MAX_HARATSAN_RULES_CHARS)}\n\n[Haratsan: .haratsanrules обрезан до ${MAX_HARATSAN_RULES_CHARS} символов]`;
}

export function formatHaratsanRulesForPrompt(text: string): string {
	return `Правила проекта (файл .haratsanrules в корне workspace):\n${text}`;
}

let manager: HaratsanRulesManager | undefined;

export function initHaratsanRulesManager(context: vscode.ExtensionContext): HaratsanRulesManager {
	manager = new HaratsanRulesManager();
	context.subscriptions.push(manager);
	return manager;
}

export function getHaratsanRulesManager(): HaratsanRulesManager | undefined {
	return manager;
}

// Файл `.haratsanrules` в корне workspace: стиль, архитектура, ограничения команды
export class HaratsanRulesManager implements vscode.Disposable {
	private text: string | undefined;
	private ready = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		void this.reload();
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				void this.reload();
			}),
		);
		this.startWatching();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}

		this.disposables.length = 0;
	}

	getText(): string | undefined {
		return this.text;
	}

	getPromptAppendix(): string | undefined {
		const text = this.text;
		return text ? formatHaratsanRulesForPrompt(text) : undefined;
	}

	async reload(): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			this.text = undefined;
			this.ready = true;
			return;
		}

		const uri = vscode.Uri.joinPath(folder.uri, HARATSAN_RULES_RELATIVE);
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const raw = new TextDecoder().decode(bytes);
			this.text = normalizeHaratsanRulesText(raw);
		} catch {
			this.text = undefined;
		}

		this.ready = true;
	}

	isReady(): boolean {
		return this.ready;
	}

	private startWatching(): void {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, HARATSAN_RULES_RELATIVE));
		const notify = () => {
			void this.reload();
		};
		this.disposables.push(
			watcher,
			watcher.onDidChange(notify),
			watcher.onDidCreate(notify),
			watcher.onDidDelete(notify),
		);
	}
}
