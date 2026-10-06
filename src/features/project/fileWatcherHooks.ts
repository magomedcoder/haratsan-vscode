import * as vscode from 'vscode';
import { writeLog } from '../../core/log/logger';
import { runFileWatcherHook, type FileWatcherEventKind } from './hooks';

const DEBOUNCE_MS = 400;
const HARATSAN_GLOB = '.haratsan/**';

export function initFileWatcherHooks(context: vscode.ExtensionContext): FileWatcherHooksManager {
	const manager = new FileWatcherHooksManager();
	context.subscriptions.push(manager);
	return manager;
}

// Лёгкий watcher на `.haratsan/**`: debounce * hook `file.watcher` (notify-only)
export class FileWatcherHooksManager implements vscode.Disposable {
	private readonly folderListener: vscode.Disposable;
	private watchDisposables: vscode.Disposable[] = [];
	private pending = new Map<string, FileWatcherEventKind>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private flushing = false;

	constructor() {
		this.folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			this.restartWatching();
		});
		this.restartWatching();
	}

	dispose(): void {
		this.clearTimer();
		this.pending.clear();
		this.folderListener.dispose();
		this.disposeWatchers();
	}

	private disposeWatchers(): void {
		for (const d of this.watchDisposables) {
			d.dispose();
		}
		this.watchDisposables = [];
	}

	private restartWatching(): void {
		this.clearTimer();
		this.pending.clear();
		this.disposeWatchers();

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}

		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(folder, HARATSAN_GLOB),
		);
		this.watchDisposables = [
			watcher,
			watcher.onDidCreate((uri) => this.queue(uri, 'create')),
			watcher.onDidChange((uri) => this.queue(uri, 'change')),
			watcher.onDidDelete((uri) => this.queue(uri, 'delete')),
		];
	}

	private queue(uri: vscode.Uri, event: FileWatcherEventKind): void {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const rel = folder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath;
		// Последнее событие по пути побеждает в окне debounce
		this.pending.set(rel, event);
		this.clearTimer();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, DEBOUNCE_MS);
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private async flush(): Promise<void> {
		if (this.flushing || this.pending.size === 0) {
			return;
		}
		
		this.flushing = true;
		const entries = [...this.pending.entries()].map(([path, event]) => ({ path, event }));
		this.pending.clear();
		try {
			await runFileWatcherHook(entries);
		} catch (err) {
			writeLog(
				'agent',
				`[hooks] file.watcher error: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			this.flushing = false;
			// События, пришедшие во время flush
			if (this.pending.size > 0 && this.timer === undefined) {
				this.timer = setTimeout(() => {
					this.timer = undefined;
					void this.flush();
				}, DEBOUNCE_MS);
			}
		}
	}
}
