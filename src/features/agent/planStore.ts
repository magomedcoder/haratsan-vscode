import * as vscode from 'vscode';
import { applyPlanFileText, DEFAULT_PLAN_RELATIVE, serializePlanMarkdown } from './planFile';
import type { PlanReloadResult } from './planFile';
import type { StickyPlan, StickyPlanSnapshot } from './plan';

// Читает/пишет .haratsan/plan.md в первой папке workspace
export class WorkspacePlanStore {
	private lastCanonical = '';
	private watcher?: vscode.FileSystemWatcher;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly onExternalChange?: () => void) {}

	get relativePath(): string {
		return DEFAULT_PLAN_RELATIVE;
	}

	resolveUri(): vscode.Uri | undefined {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return undefined;
		}

		return vscode.Uri.joinPath(folder.uri, ...DEFAULT_PLAN_RELATIVE.split('/'));
	}

	startWatching(): void {
		if (this.watcher || !vscode.workspace.workspaceFolders?.[0]) {
			return;
		}

		const folder = vscode.workspace.workspaceFolders[0];
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, DEFAULT_PLAN_RELATIVE));
		const notify = () => this.onExternalChange?.();
		this.disposables.push(
			this.watcher,
			this.watcher.onDidChange(notify),
			this.watcher.onDidCreate(notify),
			this.watcher.onDidDelete(notify),
		);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}

		this.disposables.length = 0;
		this.watcher = undefined;
	}

	async readRaw(): Promise<string | undefined> {
		const uri = this.resolveUri();
		if (!uri) {
			return undefined;
		}

		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			return doc.getText();
		} catch {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				return new TextDecoder().decode(bytes);
			} catch {
				return undefined;
			}
		}
	}

	async writeSnapshot(snap: StickyPlanSnapshot | undefined): Promise<void> {
		const uri = this.resolveUri();
		if (!uri) {
			return;
		}

		if (!snap?.steps.length) {
			await this.deleteFile();
			this.lastCanonical = '';
			return;
		}

		const markdown = serializePlanMarkdown(snap);
		await this.ensureParent(uri);
		const bytes = new TextEncoder().encode(markdown);

		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			const edit = new vscode.WorkspaceEdit();
			const last = Math.max(0, doc.lineCount - 1);
			edit.replace(doc.uri, new vscode.Range(0, 0, last, doc.lineAt(last).text.length), markdown);
			await vscode.workspace.applyEdit(edit);
			await doc.save();
		} catch {
			await vscode.workspace.fs.writeFile(uri, bytes);
		}

		this.lastCanonical = markdown;
	}

	async deleteFile(): Promise<void> {
		const uri = this.resolveUri();
		if (!uri) {
			this.lastCanonical = '';
			return;
		}

		try {
			await vscode.workspace.fs.delete(uri, { useTrash: true });
		} catch {}
		this.lastCanonical = '';
	}

	async reload(plan: StickyPlan): Promise<PlanReloadResult> {
		const raw = await this.readRaw();
		const result = applyPlanFileText(plan, raw, this.lastCanonical, DEFAULT_PLAN_RELATIVE);
		if (!result.parseError) {
			this.lastCanonical = result.nextCanonical;
		}

		return result;
	}

	// Сбросить канон для diff; план загружается заново из `.haratsan/plan.md`
	resetCanonical(): void {
		this.lastCanonical = '';
	}

	async openInEditor(): Promise<void> {
		const uri = this.resolveUri();
		if (!uri) {
			void vscode.window.showWarningMessage(vscode.l10n.t('plan.noWorkspace'));
			return;
		}

		const snapExists = await this.readRaw();
		if (snapExists === undefined) {
			void vscode.window.showWarningMessage(vscode.l10n.t('plan.fileNotCreated', DEFAULT_PLAN_RELATIVE));
			return;
		}

		await vscode.window.showTextDocument(uri, { preview: false });
	}

	private async ensureParent(uri: vscode.Uri): Promise<void> {
		const dir = vscode.Uri.joinPath(uri, '..');
		try {
			await vscode.workspace.fs.stat(dir);
		} catch {
			await vscode.workspace.fs.createDirectory(dir);
		}
	}
}
