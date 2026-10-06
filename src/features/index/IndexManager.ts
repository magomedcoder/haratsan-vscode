import * as vscode from 'vscode';
import { isIgnoredByGitIgnore, matchesWatcherIgnore } from '../agent/gitIgnore';
import { getSettings } from '../../core/config/settings';
import { isProjectEnabled } from '../project/config';
import { chunkFileContent } from './chunk';
import { applyDirDigests, canSkipDirRewalk, parentDir } from './dirDigests';
import { contentHash } from './hash';
import { listIndexableFiles, readIndexableText } from './scanner';
import { IndexAbortFlag, isIndexAbortError, summarizePartialErrors } from './manifestParse';
import { loadManifest, repairManifestFile, saveManifest } from './store';
import { maybeRefreshSymbolIndex, removeSymbolIndexPath, updateSymbolIndexForFile } from './symbolIndex';
import { maybeRefreshOutlineIndex, removeOutlineIndexPath, updateOutlineIndexForFile } from './tsOutline';
import { rebuildManifestTrigrams, searchTrigrams } from './trigram';
import type { CodebaseSearchHit, IndexManifest, IndexProgress } from './types';

export class IndexManager implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly progressByFolder = new Map<string, IndexProgress>();
	private indexing = new Set<string>();
	private indexed = new Set<string>();
	private readonly onChangeListeners = new Set<() => void>();
	// Флаги отмены текущей fullIndex по корню workspace
	private readonly abortByFolder = new Map<string, IndexAbortFlag>();
	// Debounce инкрементальных outline/symbol после watcher
	private outlineRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingSideIndex = new Map<string, { upsert: Set<string>; remove: Set<string> }>();

	constructor(private readonly context: vscode.ExtensionContext) {
		void this.bootstrapExisting();

		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders((e) => {
				for (const folder of e.added) {
					// Не автоиндексировать новые папки, если indexNewFolders выкл.
					if (getSettings().indexNewFolders === false) {
						continue;
					}
					void this.maybeSchedule(folder);
				}

				for (const folder of e.removed) {
					this.progressByFolder.delete(folder.uri.fsPath);
					this.indexed.delete(folder.uri.fsPath);
				}
				this.notifyChanged();
			}),
			vscode.workspace.createFileSystemWatcher('**/*'),
		);

		const watcher = this.disposables[this.disposables.length - 1] as vscode.FileSystemWatcher;
		const onFsChange = (uri: vscode.Uri) => {
			void this.onWorkspaceFileChange(uri);
		};

		this.disposables.push(
			watcher.onDidChange(onFsChange),
			watcher.onDidCreate(onFsChange),
			watcher.onDidDelete((uri) => {
				void this.onWorkspaceFileDelete(uri);
			}),
		);
	}

	dispose(): void {
		for (const timer of this.outlineRefreshTimers.values()) {
			clearTimeout(timer);
		}
		this.outlineRefreshTimers.clear();
		this.pendingSideIndex.clear();

		for (const flag of this.abortByFolder.values()) {
			flag.abort();
		}
		this.abortByFolder.clear();

		for (const d of this.disposables) {
			d.dispose();
		}

		this.disposables.length = 0;
		this.onChangeListeners.clear();
	}

	// Отменить идущую fullIndex для папки (или первого корня workspace)
	cancelIndex(folderFsPath?: string): void {
		const key = folderFsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!key) {
			return;
		}

		const flag = this.abortByFolder.get(key);
		if (flag) {
			flag.abort();
		}
	}

	/**
	 * Починить corrupt `.gen/index/manifest.json` и переиндексировать.
	 * Битый JSON -> empty; missing dirDigests -> recompute; затем force fullIndex.
	 */
	async repairAndReindex(folder?: vscode.WorkspaceFolder): Promise<void> {
		const target = folder ?? vscode.workspace.workspaceFolders?.[0];
		if (!target) {
			return;
		}

		if (getSettings().indexingEnabled === false) {
			return;
		}

		const key = target.uri.fsPath;
		// Если уже идёт индексация - отменить и дождаться освобождения слота
		if (this.indexing.has(key)) {
			this.cancelIndex(key);
			for (let i = 0; i < 50 && this.indexing.has(key); i += 1) {
				await new Promise((r) => setTimeout(r, 100));
			}
		}

		this.setProgress(key, {
			state: 'indexing',
			lastError: undefined,
			partialErrors: undefined,
		});

		try {
			await repairManifestFile(key);
			await this.scheduleFullIndex(target, true);
		} catch (err) {
			if (isIndexAbortError(err)) {
				return;
			}
			
			this.setProgress(key, {
				state: 'error',
				lastError: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Coalesce per-file outline + LSP symbol updates после reindex/delete от watcher
	private scheduleOutlineAndSymbolsRefresh(
		folder: vscode.WorkspaceFolder,
		relative?: string,
		opts?: { deleted?: boolean },
	): void {
		const key = folder.uri.fsPath;
		if (relative) {
			let bag = this.pendingSideIndex.get(key);
			if (!bag) {
				bag = {
					upsert: new Set(),
					remove: new Set()
				};
				this.pendingSideIndex.set(key, bag);
			}

			if (opts?.deleted) {
				bag.upsert.delete(relative);
				bag.remove.add(relative);
			} else {
				bag.remove.delete(relative);
				bag.upsert.add(relative);
			}
		}

		const prev = this.outlineRefreshTimers.get(key);
		if (prev) {
			clearTimeout(prev);
		}

		this.outlineRefreshTimers.set(
			key,
			setTimeout(() => {
				this.outlineRefreshTimers.delete(key);
				const pending = this.pendingSideIndex.get(key);
				this.pendingSideIndex.delete(key);
				if (pending && (pending.upsert.size > 0 || pending.remove.size > 0)) {
					void this.flushSideIndexUpdates(folder, pending);
					return;
				}

				// Fallback: полный refresh (например после fullIndex без путей)
				void maybeRefreshSymbolIndex(folder);
				void maybeRefreshOutlineIndex(folder);
			}, 800),
		);
	}

	private async flushSideIndexUpdates(
		folder: vscode.WorkspaceFolder,
		pending: { upsert: Set<string>; remove: Set<string> },
	): Promise<void> {
		for (const relative of pending.remove) {
			try {
				await removeOutlineIndexPath(folder, relative);
				await removeSymbolIndexPath(folder, relative);
			} catch {}
		}

		for (const relative of pending.upsert) {
			const uri = vscode.Uri.joinPath(folder.uri, ...relative.split('/'));
			try {
				await updateOutlineIndexForFile(folder, relative, uri);
				await updateSymbolIndexForFile(folder, relative, uri);
			} catch {}
		}
	}

	onDidChange(listener: () => void): vscode.Disposable {
		this.onChangeListeners.add(listener);
		return {
			dispose: () => {
				this.onChangeListeners.delete(listener);
			},
		};
	}

	private notifyChanged(): void {
		for (const listener of this.onChangeListeners) {
			listener();
		}
	}

	getProgress(folderFsPath?: string): IndexProgress {
		const key = folderFsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!key) {
			return {
				state: 'idle',
				fileCount: 0,
				chunkCount: 0,
			};
		}

		return this.progressByFolder.get(key) ?? {
			state: 'idle',
			fileCount: 0,
			chunkCount: 0,
		};
	}

	// Создать индекс после того, как пользователь подтвердит свое согласие (запись в каталог `.gen/`)
	async enableAndIndex(folder: vscode.WorkspaceFolder): Promise<void> {
		if (getSettings().indexingEnabled === false) {
			return;
		}
		await this.scheduleFullIndex(folder, true);
	}

	async search(query: string, maxResults: number): Promise<CodebaseSearchHit[]> {
		if (getSettings().indexingEnabled === false) {
			return [];
		}

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return [];
		}

		const key = folder.uri.fsPath;
		if (!(await isProjectEnabled(key))) {
			return [];
		}

		if (!this.indexed.has(key) && !this.indexing.has(key)) {
			void this.scheduleFullIndex(folder);
		}

		const manifest = await loadManifest(key);
		const ranked = searchTrigrams(manifest, query, maxResults);
		const hits: CodebaseSearchHit[] = [];

		for (const row of ranked) {
			const chunk = manifest.chunks[row.chunkId];
			if (!chunk) {
				continue;
			}

			const snippet = chunk.text.length > 400 ? `${chunk.text.slice(0, 400)}...` : chunk.text;

			hits.push({
				chunkId: chunk.id,
				path: chunk.path,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				score: row.score,
				snippet,
			});
		}

		return hits;
	}

	private async bootstrapExisting(): Promise<void> {
		if (getSettings().indexingEnabled === false) {
			return;
		}

		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			await this.maybeSchedule(folder);
		}
	}

	private async maybeSchedule(folder: vscode.WorkspaceFolder): Promise<void> {
		if (getSettings().indexingEnabled === false) {
			return;
		}

		if (!(await isProjectEnabled(folder.uri.fsPath))) {
			return;
		}

		void this.scheduleFullIndex(folder);
	}

	// true - событие watcher'а нужно пропустить (настройки / gitignore)
	private async shouldSkipWatcherPath(folder: vscode.WorkspaceFolder, relative: string): Promise<boolean> {
		if (!relative || relative.startsWith('.gen/')) {
			return true;
		}

		if (matchesWatcherIgnore(relative, getSettings().watcherIgnore)) {
			return true;
		}

		if (await isIgnoredByGitIgnore(folder.uri.fsPath, relative)) {
			return true;
		}

		return false;
	}

	private async onWorkspaceFileChange(uri: vscode.Uri): Promise<void> {
		if (getSettings().indexingEnabled === false) {
			return;
		}

		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return;
		}

		if (!(await isProjectEnabled(folder.uri.fsPath))) {
			return;
		}

		const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
		if (await this.shouldSkipWatcherPath(folder, relative)) {
			return;
		}

		void this.reindexFile(folder, relative, uri);
	}

	private async onWorkspaceFileDelete(uri: vscode.Uri): Promise<void> {
		if (getSettings().indexingEnabled === false) {
			return;
		}

		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return;
		}

		if (!(await isProjectEnabled(folder.uri.fsPath))) {
			return;
		}

		const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
		if (await this.shouldSkipWatcherPath(folder, relative)) {
			return;
		}

		void this.removeFile(folder.uri.fsPath, relative);
	}

	private setProgress(folderFsPath: string, patch: Partial<IndexProgress>): void {
		const prev = this.progressByFolder.get(folderFsPath) ?? {
			state: 'idle' as const,
			fileCount: 0,
			chunkCount: 0,
		};

		this.progressByFolder.set(folderFsPath, { ...prev, ...patch });
		this.notifyChanged();
	}

	private async scheduleFullIndex(folder: vscode.WorkspaceFolder, force = false): Promise<void> {
		const key = folder.uri.fsPath;
		if (!force && this.indexed.has(key)) {
			return;
		}

		if (this.indexing.has(key)) {
			return;
		}

		const abort = new IndexAbortFlag();
		this.abortByFolder.set(key, abort);
		this.indexing.add(key);
		this.setProgress(key, {
			state: 'indexing',
			lastError: undefined,
			partialErrors: undefined,
		});

		try {
			const result = await this.fullIndex(folder, abort);
			this.indexed.add(key);
			const manifest = await loadManifest(key);
			const fileCount = Object.keys(manifest.files).length;
			const chunkCount = Object.keys(manifest.chunks).length;

			if (result.cancelled) {
				this.setProgress(key, {
					state: 'cancelled',
					fileCount,
					chunkCount,
					updatedAt: manifest.updatedAt,
					lastError: 'Indexing cancelled',
					partialErrors: result.partialErrors.length > 0 ? result.partialErrors : undefined,
				});
				return;
			}

			const summary = summarizePartialErrors(result.partialErrors);
			this.setProgress(key, {
				state: 'ready',
				fileCount,
				chunkCount,
				updatedAt: manifest.updatedAt,
				lastError: summary || undefined,
				partialErrors: result.partialErrors.length > 0 ? result.partialErrors : undefined,
			});
			void maybeRefreshSymbolIndex(folder);
			void maybeRefreshOutlineIndex(folder);
		} catch (err) {
			if (isIndexAbortError(err) || abort.aborted) {
				const manifest = await loadManifest(key).catch(() => undefined);
				this.setProgress(key, {
					state: 'cancelled',
					fileCount: manifest ? Object.keys(manifest.files).length : 0,
					chunkCount: manifest ? Object.keys(manifest.chunks).length : 0,
					updatedAt: manifest?.updatedAt,
					lastError: 'Indexing cancelled',
				});
				return;
			}

			this.setProgress(key, {
				state: 'error',
				lastError: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.indexing.delete(key);
			this.abortByFolder.delete(key);
			this.notifyChanged();
		}
	}

	private async fullIndex(
		folder: vscode.WorkspaceFolder,
		abort?: IndexAbortFlag,
	): Promise<{ cancelled: boolean; partialErrors: string[] }> {
		const folderFsPath = folder.uri.fsPath;
		const manifest = await loadManifest(folderFsPath);
		const files = await listIndexableFiles(folder);
		const seen = new Set<string>();
		const partialErrors: string[] = [];

		// Stat size+mtime (cheap) для content-hash Merkle skip
		type FileMeta = {
			relative: string;
			uri: vscode.Uri;
			size: number;
			mtimeMs?: number;
		};
		const withMeta: FileMeta[] = [];
		for (const file of files) {
			abort?.throwIfAborted();
			seen.add(file.relative);
			let size = -1;
			let mtimeMs: number | undefined;
			try {
				const st = await vscode.workspace.fs.stat(file.uri);
				size = st.size;
				mtimeMs = st.mtime;
			} catch {
				size = -1;
			}
			withMeta.push({ relative: file.relative, uri: file.uri, size, mtimeMs });
		}

		// Группы по родительскому каталогу
		const byParent = new Map<string, FileMeta[]>();
		for (const row of withMeta) {
			const parent = parentDir(row.relative);
			const list = byParent.get(parent) ?? [];
			list.push(row);
			byParent.set(parent, list);
		}

		const skipFiles = new Set<string>();
		for (const [dir, group] of byParent) {
			abort?.throwIfAborted();
			const candidates = group.map((f) => {
				const prev = manifest.files[f.relative];
				// size+mtime match -> доверяем stored content-hash без чтения байт
				if (
					prev &&
					prev.size === f.size &&
					prev.mtimeMs !== undefined &&
					f.mtimeMs !== undefined &&
					prev.mtimeMs === f.mtimeMs
				) {
					return {
						relative: f.relative,
						size: f.size,
						mtimeMs: f.mtimeMs,
						contentHash: prev.hash,
					};
				}

				return {
					relative: f.relative,
					size: f.size,
					mtimeMs: f.mtimeMs,
				};
			});

			if (canSkipDirRewalk(manifest, dir, candidates)) {
				for (const f of group) {
					skipFiles.add(f.relative);
				}
			}
		}

		let cancelled = false;
		for (const file of withMeta) {
			if (abort?.aborted) {
				cancelled = true;
				break;
			}

			if (skipFiles.has(file.relative)) {
				continue;
			}

			try {
				await this.indexOneFile(manifest, folderFsPath, file.relative, file.uri, {
					save: false,
					mtimeMs: file.mtimeMs,
				});
			} catch (err) {
				if (isIndexAbortError(err)) {
					cancelled = true;
					break;
				}
				// Partial failure: не валим весь индекс - копим ошибку и идём дальше
				const msg = err instanceof Error ? err.message : String(err);
				partialErrors.push(`${file.relative}: ${msg}`);
			}
		}

		if (!cancelled) {
			for (const relative of Object.keys(manifest.files)) {
				if (!seen.has(relative)) {
					this.dropFile(manifest, relative);
				}
			}
		}

		rebuildManifestTrigrams(manifest);
		applyDirDigests(manifest);
		await saveManifest(folderFsPath, manifest);
		// Локальный vector index (feature hashing) - рядом с trigrams
		if (!cancelled) {
			try {
				const { rebuildLocalVectorIndex } = await import('./embeddings');
				await rebuildLocalVectorIndex(folderFsPath);
			} catch {
				// soft-fail: semantic_search построит lazy при первом запросе
			}
		}

		this.setProgress(folderFsPath, {
			fileCount: Object.keys(manifest.files).length,
			chunkCount: Object.keys(manifest.chunks).length,
			partialErrors: partialErrors.length > 0 ? partialErrors : undefined,
		});

		return { cancelled, partialErrors };
	}

	private async reindexFile(folder: vscode.WorkspaceFolder, relative: string, uri: vscode.Uri): Promise<void> {
		const folderFsPath = folder.uri.fsPath;
		const manifest = await loadManifest(folderFsPath);
		let mtimeMs: number | undefined;
		try {
			mtimeMs = (await vscode.workspace.fs.stat(uri)).mtime;
		} catch {
			mtimeMs = undefined;
		}

		const result = await this.indexOneFile(manifest, folderFsPath, relative, uri, {
			save: false,
			mtimeMs,
		});
		if (result === 'none') {
			return;
		}

		if (result === 'content') {
			rebuildManifestTrigrams(manifest);
			applyDirDigests(manifest);
		}

		await saveManifest(folderFsPath, manifest);
		if (result === 'content') {
			try {
				const { rebuildLocalVectorIndex } = await import('./embeddings');
				await rebuildLocalVectorIndex(folderFsPath);
			} catch {}
		}
		this.setProgress(folderFsPath, {
			state: 'ready',
			fileCount: Object.keys(manifest.files).length,
			chunkCount: Object.keys(manifest.chunks).length,
			updatedAt: manifest.updatedAt,
		});
		if (result === 'content') {
			this.scheduleOutlineAndSymbolsRefresh(folder, relative);
		}
	}

	private async removeFile(folderFsPath: string, relative: string): Promise<void> {
		const manifest = await loadManifest(folderFsPath);
		if (!manifest.files[relative]) {
			return;
		}

		this.dropFile(manifest, relative);
		rebuildManifestTrigrams(manifest);
		applyDirDigests(manifest);
		await saveManifest(folderFsPath, manifest);
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderFsPath));
		if (folder) {
			this.scheduleOutlineAndSymbolsRefresh(folder, relative, { deleted: true });
		}
	}

	private dropFile(manifest: IndexManifest, relative: string): void {
		const record = manifest.files[relative];
		if (!record) {
			return;
		}

		for (const chunkId of record.chunkIds) {
			delete manifest.chunks[chunkId];
		}

		delete manifest.files[relative];
	}

	private async indexOneFile(
		manifest: IndexManifest,
		folderFsPath: string,
		relative: string,
		uri: vscode.Uri,
		opts: {
			save: boolean;
			mtimeMs?: number;
		},
	): Promise<'content' | 'meta' | 'none'> {
		const text = await readIndexableText(uri);
		if (text === undefined) {
			if (manifest.files[relative]) {
				this.dropFile(manifest, relative);
				if (opts.save) {
					rebuildManifestTrigrams(manifest);
					applyDirDigests(manifest);
					await saveManifest(folderFsPath, manifest);
				}

				return 'content';
			}

			return 'none';
		}

		const hash = contentHash(text);
		const size = Buffer.byteLength(text, 'utf8');
		const mtimeMs = opts.mtimeMs;
		const prev = manifest.files[relative];
		if (prev?.hash === hash) {
			const metaChanged = prev.size !== size || (mtimeMs !== undefined && prev.mtimeMs !== mtimeMs);
			if (!metaChanged) {
				return 'none';
			}

			manifest.files[relative] = {
				...prev,
				size,
				...(mtimeMs !== undefined ? { mtimeMs } : {}),
			};
			if (opts.save) {
				await saveManifest(folderFsPath, manifest);
			}

			return 'meta';
		}

		if (prev) {
			this.dropFile(manifest, relative);
		}

		const chunks = chunkFileContent(relative, text);
		const chunkIds: string[] = [];
		for (const chunk of chunks) {
			manifest.chunks[chunk.id] = chunk;
			chunkIds.push(chunk.id);
		}

		manifest.files[relative] = {
			hash,
			size,
			chunkIds,
			...(mtimeMs !== undefined ? { mtimeMs } : {}),
		};

		if (opts.save) {
			rebuildManifestTrigrams(manifest);
			applyDirDigests(manifest);
			await saveManifest(folderFsPath, manifest);
		}

		return 'content';
	}
}

let instance: IndexManager | undefined;

export function initIndexManager(context: vscode.ExtensionContext): IndexManager {
	if (!instance) {
		instance = new IndexManager(context);
		context.subscriptions.push(instance);
	}

	return instance;
}

export function getIndexManager(): IndexManager | undefined {
	// При выключенном indexingEnabled инструменты видят «пустой» менеджер
	if (getSettings().indexingEnabled === false) {
		return undefined;
	}
	
	return instance;
}

// Экземпляр для UI-статуса (даже если indexingEnabled выкл.)
export function getIndexManagerInstance(): IndexManager | undefined {
	return instance;
}
