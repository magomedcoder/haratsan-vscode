/**
 * Персистентный индекс / map в VS Code workspace storage (`context.storageUri`), не в `.haratsan/` проекта.
 *
 * Layout:
 *   <storageUri>/index/<folderKey>/{manifest,vectors,symbols,outline}.json
 *   <storageUri>/map/<folderKey>/project.json
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';

export const INDEX_MANIFEST_FILE = 'manifest.json';
export const INDEX_VECTORS_FILE = 'vectors.json';
export const INDEX_SYMBOLS_FILE = 'symbols.json';
export const INDEX_OUTLINE_FILE = 'outline.json';
const PROJECT_MAP_FILE = 'project.json';

let storageRoot: string | undefined;

export function initIndexStorage(context: ExtensionContext): void {
	storageRoot = context.storageUri?.fsPath;
}

// Для тестов: подменить корень storage
export function setIndexStorageRootForTests(root: string | undefined): void {
	storageRoot = root;
}

// Стабильный короткий ключ workspace-папки (абсолютный путь)
export function folderStorageKey(folderFsPath: string): string {
	return createHash('sha256').update(folderFsPath).digest('hex').slice(0, 16);
}

// Каталог артефактов индекса для папки. undefined - нет storageUri
export function indexDirForFolder(folderFsPath: string): string | undefined {
	if (!storageRoot) {
		return undefined;
	}
	
	return path.join(storageRoot, 'index', folderStorageKey(folderFsPath));
}

// Каталог кэша project_map для папки
export function mapDirForFolder(folderFsPath: string): string | undefined {
	if (!storageRoot) {
		return undefined;
	}

	return path.join(storageRoot, 'map', folderStorageKey(folderFsPath));
}

export function indexFilePath(folderFsPath: string, fileName: string): string | undefined {
	const dir = indexDirForFolder(folderFsPath);
	if (!dir) {
		return undefined;
	}

	return path.join(dir, fileName);
}

export function mapFilePath(folderFsPath: string): string | undefined {
	const dir = mapDirForFolder(folderFsPath);
	if (!dir) {
		return undefined;
	}

	return path.join(dir, PROJECT_MAP_FILE);
}

export function isIndexStorageAvailable(): boolean {
	return Boolean(storageRoot);
}
