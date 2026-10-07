import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import type { HaratsanSettings } from '../../core/config/types';
import { isIndexStorageAvailable } from './indexStorage';
import { getIndexManagerInstance } from './IndexManager';
import { inspectManifest, loadManifest } from './store';
import type { IndexProgress } from './types';

/**
 * Режим движка индекса / семантического поиска.
 * Outline: Tree-sitter wasm / TS API / LSP -> workspace storage outline.json.
 */
export type IndexEngineMode = 'cpu-trigram' | 'remote' | 'local-vector';

export interface IndexEngineStatus {
	mode: IndexEngineMode;
	// GPU-ускорение - всегда false (нет локального GPU embedding runtime)
	gpu: boolean;
	indexingEnabled: boolean;
	progressState?: IndexProgress['state'];
	fileCount?: number;
	chunkCount?: number;
	updatedAt?: string;
	lastError?: string;
	partialErrors?: string[];
	// Битый JSON или несовместимый version манифеста
	corrupt?: boolean;
	// Есть файлы, но dirDigests пуст - нужен Repair
	missingDirDigests?: boolean;
}

/**
 * Приоритет: localEmbeddingsMode=vector -> local-vector;
 * иначе remote если есть embeddingsBaseUrl|baseUrl;
 * иначе CPU trigram.
 */
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

	if (folderFs) {
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
					lastError = lastError || `Corrupt index manifest (${probe.repairReason ?? 'invalid'})`;
				} else if (
					probe.missingDirDigests &&
					(!progressState || progressState === 'idle' || progressState === 'ready') &&
					!lastError
				) {
					lastError = 'Missing dirDigests - Repair recommended';
				}
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
	};
}
