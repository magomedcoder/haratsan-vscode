import * as vscode from 'vscode';
import { isIgnoredByGitIgnore, matchesWatcherIgnore } from '../agent/gitIgnore';
import { getSettings } from '../../core/config/settings';
import { emitIndexMerkleMetrics } from '../../core/llm/otel';
import { chunkFileContent, chunkFileContentAst } from './chunk';
import { canSkipDirRewalk, parentDir } from './dirDigests';
import { contentHash } from './hash';
import { applyTreeSitterSettings, shouldUseTreeSitterChunk } from './indexEngines';
import { folderStorageKey, initIndexStorage, isIndexStorageAvailable } from './indexStorage';
import { recordChunkEngineUse, recordMerkleSkipStats, recordOutlineBreakdown, resetIndexRunStats } from './indexStats';
import { saveMerkleToSqlite, shouldUseSqliteStorage } from './indexSqlite';
import { listIndexableFiles, readIndexableText } from './scanner';
import { IndexAbortFlag, isIndexAbortError, summarizePartialErrors } from './manifestParse';
import { buildMerkleDocument, detectMerkleIssues, digestsFromChunks, dropPathFromMerkle, emptyMerkleMetrics, loadMerkle, mergeChunksPreservingDigests, patchMerkleDocument, repairMerkleFromManifest, saveMerkle, syncManifestDirDigests, unchangedSymbolLeaves } from './merkle';
import type { MerkleDocument, MerkleMetrics } from './merkle';
import { loadManifest, repairManifestFile, saveManifest } from './store';
import { maybeRefreshSymbolIndex, removeSymbolIndexPath, updateSymbolIndexForFile } from './symbolIndex';
import { initTreeSitter, parseWithTreeSitter } from './treeSitter';
import { loadOutlineIndex, maybeRefreshOutlineIndex, outlineSourceBreakdown, removeOutlineIndexPath, updateOutlineIndexForFile } from './tsOutline';
import { patchManifestTrigrams, rebuildManifestTrigrams, searchTrigrams } from './trigram';
import type { CodebaseSearchHit, IndexManifest, IndexProgress } from './types';

const NO_STORAGE_ERROR = 'Хранилище индекса недоступно (нет storageUri)';

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

	private lastEngineFingerprint = '';

	constructor(private readonly context: vscode.ExtensionContext) {
		initIndexStorage(context);
		initTreeSitter(context);
		applyTreeSitterSettings(getSettings());
		this.lastEngineFingerprint = this.engineFingerprint();
		void this.bootstrapExisting();

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					!e.affectsConfiguration('haratsan') &&
					!e.affectsConfiguration('haratsan.outlineEngine') &&
					!e.affectsConfiguration('haratsan.chunkEngine')
				) {
	
				}
				void this.maybePromptEngineReindex();
			}),
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
	 * Починить corrupt manifest.json в workspace storage и переиндексировать.
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

		if (!isIndexStorageAvailable()) {
			this.setProgress(target.uri.fsPath, {
				state: 'error',
				fileCount: 0,
				chunkCount: 0,
				lastError: NO_STORAGE_ERROR,
			});
			this.notifyChanged();
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
			const manifest = await loadManifest(key);
			const prevMerkle = await loadMerkle(key);
			const issues = detectMerkleIssues(manifest, prevMerkle);
			const merkle = repairMerkleFromManifest(manifest, prevMerkle);
			syncManifestDirDigests(manifest, merkle);
			await saveManifest(key, manifest);
			await this.persistMerkle(key, merkle, Object.keys(manifest.files).length);
			if (issues.mismatches.length || issues.orphans.length || issues.missingNodes.length) {
				console.info(`[Haratsan] merkle repair: mismatch=${issues.mismatches.length} orphan=${issues.orphans.length} missing=${issues.missingNodes.length}`);
			}
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

	// Объединить per-file обновления outline + LSP-символов после reindex/delete от watcher
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

				// Запасной путь: полный refresh (например после fullIndex без путей)
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

	// Принудительно (пере)построить индекс для папки
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

		void this.scheduleFullIndex(folder);
	}

	// true - событие watcher'а нужно пропустить (настройки / gitignore)
	private async shouldSkipWatcherPath(folder: vscode.WorkspaceFolder, relative: string): Promise<boolean> {
		if (!relative || relative.startsWith('.haratsan/')) {
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

		if (!isIndexStorageAvailable()) {
			this.setProgress(key, {
				state: 'error',
				fileCount: 0,
				chunkCount: 0,
				lastError: NO_STORAGE_ERROR,
			});
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

		// Stat size+mtime (дёшево) для пропуска по content-hash Merkle
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
				// size+mtime совпали -> доверяем сохранённому content-hash без чтения байт
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

			const forceHash = getSettings().indexForceContentHash === true;
			if (canSkipDirRewalk(manifest, dir, candidates, { forceContentHash: forceHash })) {
				for (const f of group) {
					skipFiles.add(f.relative);
				}
			}
		}

		resetIndexRunStats(folderFsPath);
		const metrics = emptyMerkleMetrics();
		metrics.filesTotal = withMeta.length;
		metrics.filesSkipped = skipFiles.size;
		metrics.dirsTotal = byParent.size;
		let dirsSkipped = 0;
		for (const [dir, group] of byParent) {
			if (group.every((f) => skipFiles.has(f.relative))) {
				dirsSkipped += 1;
			}
			void dir;
		}
		metrics.dirsSkipped = dirsSkipped;

		const prevMerkle = await loadMerkle(folderFsPath);
		let chunkDigests = { ...prevMerkle.chunkDigests };
		let symbolDigestsAcc = { ...prevMerkle.symbolDigests };
		let chunksSkipped = 0;
		let chunksIndexed = 0;
		const indexedChunkIds: string[] = [];

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
				const one = await this.indexOneFile(manifest, folderFsPath, file.relative, file.uri, {
					save: false,
					mtimeMs: file.mtimeMs,
					chunkDigests,
					prevSymbolDigests: prevMerkle.symbolDigests,
				});
				chunkDigests = one.chunkDigests;
				Object.assign(symbolDigestsAcc, one.symbolDigests);
				chunksSkipped += one.chunksSkipped;
				chunksIndexed += one.chunksIndexed;
				indexedChunkIds.push(...one.indexedIds);
				if (one.result === 'content') {
					metrics.filesIndexed += 1;
				}
			} catch (err) {
				if (isIndexAbortError(err)) {
					cancelled = true;
					break;
				}
				// Частичный сбой: не валим весь индекс - копим ошибку и идём дальше
				const msg = err instanceof Error ? err.message : String(err);
				partialErrors.push(`${file.relative}: ${msg}`);
			}
		}

		if (!cancelled) {
			for (const relative of Object.keys(manifest.files)) {
				if (!seen.has(relative)) {
					const goneIds = manifest.files[relative]?.chunkIds ?? [];
					this.dropFile(manifest, relative);
					for (const id of goneIds) {
						delete chunkDigests[id];
					}
				}
			}
		}

		metrics.chunksSkipped = chunksSkipped;
		metrics.chunksIndexed = chunksIndexed;

		rebuildManifestTrigrams(manifest);
		const merkle = patchMerkleDocument(prevMerkle, manifest.files, {
			chunkDigests: digestsFromChunks(manifest.chunks),
			symbolDigests: symbolDigestsAcc,
			metrics,
		});
		syncManifestDirDigests(manifest, merkle);
		await saveManifest(folderFsPath, manifest);
		await this.persistMerkle(folderFsPath, merkle, Object.keys(manifest.files).length);
		this.logIndexMetrics(folderFsPath, metrics);
		recordMerkleSkipStats(folderFsPath, metrics);
		try {
			const outline = await loadOutlineIndex(folderFsPath);
			if (outline) {
				recordOutlineBreakdown(folderFsPath, outlineSourceBreakdown(outline.entries));
			}
		} catch {}

		// Локальный vector index - только изменённые чанки
		if (!cancelled) {
			try {
				const { rebuildLocalVectorIndex } = await import('./embeddings');
				await rebuildLocalVectorIndex(
					folderFsPath,
					indexedChunkIds.length > 0 ? { onlyChunkIds: indexedChunkIds } : undefined,
				);
			} catch {
				// Мягкий сбой: semantic_search построит индекс лениво при первом запросе
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
		const prevMerkle = await loadMerkle(folderFsPath);
		let mtimeMs: number | undefined;
		try {
			mtimeMs = (await vscode.workspace.fs.stat(uri)).mtime;
		} catch {
			mtimeMs = undefined;
		}

		const one = await this.indexOneFile(manifest, folderFsPath, relative, uri, {
			save: false,
			mtimeMs,
			chunkDigests: { ...prevMerkle.chunkDigests },
			prevSymbolDigests: prevMerkle.symbolDigests,
		});
		if (one.result === 'none') {
			return;
		}

		if (one.result === 'content') {
			const removed = Object.keys(prevMerkle.chunkDigests).filter((id) => id.startsWith(`${relative}#`));
			const added = one.indexedIds.map((id) => manifest.chunks[id])
				.filter((c): c is NonNullable<typeof c> => Boolean(c));
			patchManifestTrigrams(manifest, {
				removedChunkIds: removed.filter((id) => !manifest.chunks[id]),
				addChunks: added,
				fullRebuild: removed.length > 40,
			});
		}

		const metrics: MerkleMetrics = {
			...emptyMerkleMetrics(),
			filesIndexed: one.result === 'content' ? 1 : 0,
			chunksIndexed: one.chunksIndexed,
			chunksSkipped: one.chunksSkipped,
			filesTotal: 1,
		};
		const merkle = patchMerkleDocument(prevMerkle, manifest.files, {
			chunkDigests: digestsFromChunks(manifest.chunks),
			symbolDigests: { ...prevMerkle.symbolDigests, ...one.symbolDigests },
			metrics,
			changedPaths: new Set([relative.replace(/\\/g, '/')]),
		});
		syncManifestDirDigests(manifest, merkle);
		await saveManifest(folderFsPath, manifest);
		await this.persistMerkle(folderFsPath, merkle, Object.keys(manifest.files).length);
		this.logIndexMetrics(folderFsPath, metrics, 'index_reindex');

		if (one.result === 'content' && one.indexedIds.length > 0) {
			try {
				const { rebuildLocalVectorIndex } = await import('./embeddings');
				await rebuildLocalVectorIndex(folderFsPath, { onlyChunkIds: one.indexedIds });
			} catch {}
		}
		this.setProgress(folderFsPath, {
			state: 'ready',
			fileCount: Object.keys(manifest.files).length,
			chunkCount: Object.keys(manifest.chunks).length,
			updatedAt: manifest.updatedAt,
		});
		if (one.result === 'content' && !one.skipOutline) {
			this.scheduleOutlineAndSymbolsRefresh(folder, relative);
		}
	}

	private async removeFile(folderFsPath: string, relative: string): Promise<void> {
		const manifest = await loadManifest(folderFsPath);
		if (!manifest.files[relative]) {
			return;
		}

		const prevMerkle = await loadMerkle(folderFsPath);
		const goneIds = manifest.files[relative]?.chunkIds ?? [];
		this.dropFile(manifest, relative);
		rebuildManifestTrigrams(manifest);
		const merkle = dropPathFromMerkle(prevMerkle, relative, goneIds);
		const rebuilt = patchMerkleDocument(merkle, manifest.files, {
			chunkDigests: digestsFromChunks(manifest.chunks),
			symbolDigests: merkle.symbolDigests,
			changedPaths: new Set([relative.replace(/\\/g, '/')]),
		});
		syncManifestDirDigests(manifest, rebuilt);
		await saveManifest(folderFsPath, manifest);
		await this.persistMerkle(folderFsPath, rebuilt, Object.keys(manifest.files).length);
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

	private logIndexMetrics(
		folderFsPath: string,
		metrics: MerkleMetrics,
		toolName: 'index_full' | 'index_reindex' = 'index_full',
	): void {
		const line = `индекс merkle: файлы ${metrics.filesIndexed}/${metrics.filesTotal}` +
			` (пропуск ${metrics.filesSkipped}), каталоги пропуск ${metrics.dirsSkipped}/${metrics.dirsTotal},` +
			` чанки +${metrics.chunksIndexed}/reuse ${metrics.chunksSkipped}`;
		console.info(`[Haratsan] ${line} @ ${folderFsPath}`);
		try {
			void import('../../core/stores/activityStore').then((mod) => {
				mod.recordActivity({
					kind: 'tool',
					label: line,
					toolName,
					status: 'ok',
					path: folderFsPath,
				});
			}).catch(() => {});
		} catch {}
		try {
			emitIndexMerkleMetrics(getSettings(), {
				...metrics,
				folderKey: folderStorageKey(folderFsPath),
			});
		} catch {}
	}

	private async persistMerkle(
		folderFsPath: string,
		merkle: MerkleDocument,
		fileCount: number,
	): Promise<void> {
		await saveMerkle(folderFsPath, merkle);
		const settings = getSettings();
		if (shouldUseSqliteStorage(fileCount, settings)) {
			await saveMerkleToSqlite(folderFsPath, merkle);
		}
	}

	private engineFingerprint(): string {
		const s = getSettings();
		return [
			s.outlineEngine,
			s.chunkEngine,
			(s.treeSitterLanguages ?? []).join(','),
			s.indexForceContentHash ? '1' : '0',
			s.indexStorageBackend,
		].join('|');
	}

	private async maybePromptEngineReindex(): Promise<void> {
		applyTreeSitterSettings(getSettings());
		const next = this.engineFingerprint();
		if (!this.lastEngineFingerprint || this.lastEngineFingerprint === next) {
			this.lastEngineFingerprint = next;
			return;
		}

		this.lastEngineFingerprint = next;
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length === 0) {
			return;
		}

		const pick = await vscode.window.showInformationMessage(
			'Haratsan: изменились outlineEngine / chunkEngine / языки Tree-sitter. Переиндексировать workspace?',
			'Переиндексировать',
			'Позже',
		);
		if (pick !== 'Переиндексировать') {
			return;
		}
		
		for (const folder of folders) {
			void this.scheduleFullIndex(folder, true);
		}
	}

	private async indexOneFile(
		manifest: IndexManifest,
		folderFsPath: string,
		relative: string,
		uri: vscode.Uri,
		opts: {
			save: boolean;
			mtimeMs?: number;
			chunkDigests?: Record<string, string>;
			prevSymbolDigests?: Record<string, string>;
		},
	): Promise<{
		result: 'content' | 'meta' | 'none';
		chunkDigests: Record<string, string>;
		chunksSkipped: number;
		chunksIndexed: number;
		symbolDigests: Record<string, string>;
		indexedIds: string[];
		skipOutline: boolean;
	}> {
		const empty = {
			chunkDigests: opts.chunkDigests ?? {},
			chunksSkipped: 0,
			chunksIndexed: 0,
			symbolDigests: {} as Record<string, string>,
			indexedIds: [] as string[],
			skipOutline: false,
		};

		const text = await readIndexableText(uri);
		if (text === undefined) {
			if (manifest.files[relative]) {
				this.dropFile(manifest, relative);
				if (opts.save) {
					rebuildManifestTrigrams(manifest);
					const merkle = repairMerkleFromManifest(manifest, await loadMerkle(folderFsPath));
					syncManifestDirDigests(manifest, merkle);
					await saveManifest(folderFsPath, manifest);
					await this.persistMerkle(folderFsPath, merkle, Object.keys(manifest.files).length);
				}
				return { ...empty, result: 'content' };
			}
			return { ...empty, result: 'none' };
		}

		const hash = contentHash(text);
		const size = Buffer.byteLength(text, 'utf8');
		const mtimeMs = opts.mtimeMs;
		const prev = manifest.files[relative];
		if (prev?.hash === hash) {
			const metaChanged = prev.size !== size || (mtimeMs !== undefined && prev.mtimeMs !== mtimeMs);
			if (!metaChanged) {
				return { ...empty, result: 'none' };
			}

			manifest.files[relative] = {
				...prev,
				size,
				...(mtimeMs !== undefined ? { mtimeMs } : {}),
			};
			if (opts.save) {
				await saveManifest(folderFsPath, manifest);
			}
			return { ...empty, result: 'meta' };
		}

		const prevChunkMap: Record<string, import('./types').IndexChunk> = {};
		const prevDigests: Record<string, string> = {
			...(opts.chunkDigests ?? {}),
		};
		if (prev) {
			for (const id of prev.chunkIds) {
				const c = manifest.chunks[id];
				if (c) {
					prevChunkMap[id] = c;
				}
			}
			this.dropFile(manifest, relative);
		}

		const settings = getSettings();
		const strictAst = settings.chunkEngine === 'treesitter';
		let nextChunks = strictAst ? [] : chunkFileContent(relative, text);
		let symbolDigests: Record<string, string> = {};
		let usedAst = false;
		if (shouldUseTreeSitterChunk(settings, relative)) {
			const parsed = await parseWithTreeSitter(relative, text);
			if (parsed && parsed.spans.length > 0) {
				nextChunks = chunkFileContentAst(relative, text, parsed.spans);
				usedAst = true;
				for (const s of parsed.spans) {
					const key = `${relative}#${s.startLine}-${s.endLine}:${s.name}`;
					symbolDigests[key] = contentHash(text.slice(s.startIndex, s.endIndex));
				}
			} else if (strictAst) {
				nextChunks = [];
			}
		}
		recordChunkEngineUse(folderFsPath, usedAst ? 'ast' : 'lines');

		const prevSym = opts.prevSymbolDigests ?? {};
		const unchanged = unchangedSymbolLeaves(prevSym, symbolDigests);
		const skipOutline =
			Object.keys(symbolDigests).length > 0 &&
			unchanged.length === Object.keys(symbolDigests).length;

		const merged = mergeChunksPreservingDigests(prevChunkMap, prevDigests, nextChunks);
		for (const id of Object.keys(prevChunkMap)) {
			if (!merged.chunks[id]) {
				delete manifest.chunks[id];
			}
		}

		for (const [id, chunk] of Object.entries(merged.chunks)) {
			manifest.chunks[id] = chunk;
		}

		manifest.files[relative] = {
			hash,
			size,
			chunkIds: merged.chunkIds,
			...(mtimeMs !== undefined ? { mtimeMs } : {}),
		};

		const chunkDigests = { ...prevDigests };
		for (const id of Object.keys(prevChunkMap)) {
			if (!merged.digests[id]) {
				delete chunkDigests[id];
			}
		}
		Object.assign(chunkDigests, merged.digests);

		if (opts.save) {
			rebuildManifestTrigrams(manifest);
			const merkle = buildMerkleDocument(manifest.files, {
				chunkDigests: digestsFromChunks(manifest.chunks),
				symbolDigests: { ...(opts.prevSymbolDigests ?? {}), ...symbolDigests },
			});
			syncManifestDirDigests(manifest, merkle);
			await saveManifest(folderFsPath, manifest);
			await this.persistMerkle(folderFsPath, merkle, Object.keys(manifest.files).length);
		}

		return {
			result: 'content',
			chunkDigests,
			chunksSkipped: merged.skippedIds.length,
			chunksIndexed: merged.indexedIds.length,
			symbolDigests,
			indexedIds: merged.indexedIds,
			skipOutline,
		};
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
