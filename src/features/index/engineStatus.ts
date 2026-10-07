import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import type { HaratsanSettings } from '../../core/config/types';
import { isIndexStorageAvailable } from './indexStorage';
import { getIndexManagerInstance } from './IndexManager';
import { astChunkRatio, getIndexRunStats } from './indexStats';
import { isSqliteIndexAvailable } from './indexSqlite';
import { detectMerkleIssues, loadMerkle } from './merkle';
import { inspectManifest, loadManifest } from './store';
import { isTreeSitterAvailable, listSupportedTreeSitterLanguages } from './treeSitter';
import type { IndexProgress } from './types';

/**
 * Режим движка индекса / семантического поиска.
 * Outline: Tree-sitter wasm / TS API / LSP -> workspace storage outline.json.
 */
export type IndexEngineMode = 'cpu-trigram' | 'remote' | 'local-vector';

export interface IndexEngineStatus {
	mode: IndexEngineMode;
	gpu: boolean;
	indexingEnabled: boolean;
	progressState?: IndexProgress['state'];
	fileCount?: number;
	chunkCount?: number;
	updatedAt?: string;
	lastError?: string;
	partialErrors?: string[];
	corrupt?: boolean;
	missingDirDigests?: boolean;
	// Расхождение manifest <-> merkle
	merkleMismatch?: boolean;
	treeSitterAvailable?: boolean;
	treeSitterGrammars?: string[];
	// 0..1 доля файлов с AST-чанками в последнем прогоне
	astChunkRatio?: number;
	outlineBySource?: Record<string, number>;
	merkleSkipPct?: number;
	indexStorageBackend?: string;
	sqliteAvailable?: boolean;
}

export function resolveIndexEngineMode(
	settings: Pick<HaratsanSettings, 'embeddingsBaseUrl' | 'baseUrl' | 'localEmbeddingsMode'>,
): IndexEngineMode {
	if (settings.localEmbeddingsMode === 'vector') {
		return 'local-vector';
	}
	const remote = String(settings.embeddingsBaseUrl ?? '').trim() || String(settings.baseUrl ?? '').trim();
	if (remote) {
		return 'remote';
	}

	return 'cpu-trigram';
}

export async function collectIndexEngineStatus(): Promise<IndexEngineStatus> {
	const settings = getSettings();
	const folderFs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const mode = resolveIndexEngineMode(settings);
	const progress = getIndexManagerInstance()?.getProgress();

	let fileCount = progress?.fileCount;
	let chunkCount = progress?.chunkCount;
	let updatedAt = progress?.updatedAt;
	let lastError = progress?.lastError;
	let progressState = progress?.state;
	const partialErrors = progress?.partialErrors;
	let corrupt = false;
	let missingDirDigests = false;
	let merkleMismatch = false;
	let astRatio: number | undefined;
	let outlineBySource: Record<string, number> | undefined;
	let merkleSkipPct: number | undefined;

	if (folderFs) {
		const stats = getIndexRunStats(folderFs);
		astRatio = astChunkRatio(stats);
		outlineBySource = stats.outlineBySource;
		if (stats.lastMerkle && stats.lastMerkle.filesTotal > 0) {
			merkleSkipPct = Math.round((100 * stats.lastMerkle.filesSkipped) / stats.lastMerkle.filesTotal);
		}
		try {
			if (!isIndexStorageAvailable()) {
				progressState = progressState && progressState !== 'idle' ? progressState : 'error';
				lastError = lastError || 'Хранилище индекса недоступно (нет storageUri)';
			} else {
				const probe = await inspectManifest(folderFs);
				corrupt = probe.corrupt;
				missingDirDigests = probe.missingDirDigests;
				if (probe.corrupt && (!progressState || progressState === 'idle' || progressState === 'ready')) {
					progressState = 'error';
					lastError = lastError || `Повреждённый manifest индекса (${probe.repairReason ?? 'invalid'})`;
				} else if (
					probe.missingDirDigests &&
					(!progressState || progressState === 'idle' || progressState === 'ready') &&
					!lastError
				) {
					lastError = 'Нет dirDigests - рекомендуется Repair';
				}
				
				try {
					const manifest = await loadManifest(folderFs);
					const merkle = await loadMerkle(folderFs);
					const issues = detectMerkleIssues(manifest, merkle);
					if (issues.mismatches.length || issues.orphans.length || issues.missingNodes.length) {
						merkleMismatch = true;
						if (!lastError) {
							lastError = `Расхождение Merkle (файлы=${issues.mismatches.length}) - рекомендуется Repair`;
						}
					}
				} catch {}
			}
		} catch {}
	}

	if (folderFs && (!updatedAt || !fileCount)) {
		try {
			const manifest = await loadManifest(folderFs);
			const epoch = new Date(manifest.updatedAt).getTime();
			if (Number.isFinite(epoch) && epoch > 0) {
				fileCount = fileCount || Object.keys(manifest.files).length;
				chunkCount = chunkCount || Object.keys(manifest.chunks).length;
				updatedAt = updatedAt || manifest.updatedAt;
				if (!progressState || progressState === 'idle') {
					progressState = 'ready';
				}
			}
		} catch {}
	}

	return {
		mode,
		gpu: false,
		indexingEnabled: settings.indexingEnabled !== false,
		progressState,
		fileCount,
		chunkCount,
		updatedAt,
		lastError,
		partialErrors,
		corrupt,
		missingDirDigests,
		merkleMismatch,
		treeSitterAvailable: isTreeSitterAvailable(),
		treeSitterGrammars: listSupportedTreeSitterLanguages(),
		astChunkRatio: astRatio,
		outlineBySource,
		merkleSkipPct,
		indexStorageBackend: settings.indexStorageBackend,
		sqliteAvailable: isSqliteIndexAvailable(),
	};
}
