import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import { shouldUseTreeSitterOutline } from './indexEngines';
import { INDEX_OUTLINE_FILE, indexDirForFolder, indexFilePath } from './indexStorage';
import { listIndexableFiles, readIndexableText } from './scanner';
import { extractOutlineViaTreeSitter } from './treeSitterOutline';
import {
	isJsLikeOutlinePath,
	isRegexOutlineFallbackPath,
	parseOutlineDocumentJson,
	parseRegexOutlineFallback,
	parseTsOutline,
	preferLspOrRegexOutline,
	outlineEntriesFromLspProviderResult,
	searchOutlineEntries,
	summarizeOutlineForPath,
	applyOutlinePathRemove,
	applyOutlinePathUpdate,
	type OutlineDocument,
	type OutlineEntry,
} from './tsOutlineParse';

export type { OutlineDocument, OutlineEntry } from './tsOutlineParse';
export {
	isJsLikeOutlinePath,
	isRegexOutlineFallbackPath,
	parseOutlineDocumentJson,
	parseRegexOutlineFallback,
	parseTsOutline,
	preferLspOrRegexOutline,
	mapLspSymbolKindToOutlineKind,
	flattenLspDocumentSymbolsToOutline,
	flattenLspSymbolInfosToOutline,
	outlineEntriesFromLspProviderResult,
	scoreOutlineQuery,
	searchOutlineEntries,
	summarizeOutlineForPath,
	applyOutlinePathRemove,
	applyOutlinePathUpdate,
} from './tsOutlineParse';

export const OUTLINE_INDEX_LIMITS = {
	maxFiles: 400,
	maxEntries: 12_000,
	maxFileBytes: 400_000,
	lspThrottleMs: 40,
} as const;

function outlinePathForFolder(folderFsPath: string): string | undefined {
	return indexFilePath(folderFsPath, INDEX_OUTLINE_FILE);
}

export async function loadOutlineIndex(folderFsPath: string): Promise<OutlineDocument | undefined> {
	const file = outlinePathForFolder(folderFsPath);
	if (!file) {
		return undefined;
	}

	try {
		const raw = await fs.readFile(file, 'utf8');
		return parseOutlineDocumentJson(raw);
	} catch {
		return undefined;
	}
}

export async function saveOutlineIndex(folderFsPath: string, doc: OutlineDocument): Promise<void> {
	const dir = indexDirForFolder(folderFsPath);
	const file = outlinePathForFolder(folderFsPath);
	if (!dir || !file) {
		return;
	}
	
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
}

/** Синхронное извлечение: TS/JS через createSourceFile; остальные языки - только regex fallback. */
export function extractOutlineForFile(relativePath: string, sourceText: string): OutlineEntry[] {
	if (isJsLikeOutlinePath(relativePath)) {
		return parseTsOutline(relativePath, sourceText);
	}

	if (isRegexOutlineFallbackPath(relativePath)) {
		return parseRegexOutlineFallback(relativePath, sourceText);
	}
	return [];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * LSP DocumentSymbolProvider -> outline entries одного файла.
 * Пусто, если нет provider / символов (caller может упасть на regex).
 */
export async function extractOutlineFromLsp(
	relativePath: string,
	uri: vscode.Uri,
	maxEntries: number = OUTLINE_INDEX_LIMITS.maxEntries,
): Promise<OutlineEntry[]> {
	try {
		const result = await vscode.commands.executeCommand<unknown>(
			'vscode.executeDocumentSymbolProvider',
			uri,
		);
		return outlineEntriesFromLspProviderResult(result, relativePath, maxEntries);
	} catch {
		return [];
	}
}

// Порядок: Tree-sitter (если engine позволяет) -> TS / LSP / regex.
// Строгий режим: outlineEngine=treesitter без скрытого запасного пути.
export async function extractOutlineForFileAsync(
	relativePath: string,
	uri: vscode.Uri,
	sourceText: string | undefined,
): Promise<OutlineEntry[]> {
	const settings = getSettings();
	const eng = settings.outlineEngine ?? 'auto';
	const strictTreesitter = eng === 'treesitter';

	if (sourceText && shouldUseTreeSitterOutline(settings, relativePath)) {
		const tsOutline = await extractOutlineViaTreeSitter(relativePath, sourceText);
		if (tsOutline && tsOutline.length > 0) {
			return tsOutline;
		}
		if (strictTreesitter) {
			return [];
		}
	} else if (strictTreesitter) {
		return [];
	}

	if (isJsLikeOutlinePath(relativePath)) {
		if (!sourceText) {
			return [];
		}
		if (eng === 'lsp') {
			return extractOutlineFromLsp(relativePath, uri);
		}
		return parseTsOutline(relativePath, sourceText);
	}

	if (eng === 'typescript') {
		if (sourceText && isRegexOutlineFallbackPath(relativePath)) {
			return parseRegexOutlineFallback(relativePath, sourceText);
		}
		return [];
	}

	const remaining = OUTLINE_INDEX_LIMITS.maxEntries;
	const lsp = await extractOutlineFromLsp(relativePath, uri, remaining);
	if (lsp.length > 0) {
		return lsp;
	}

	if (sourceText && isRegexOutlineFallbackPath(relativePath)) {
		return preferLspOrRegexOutline(lsp, parseRegexOutlineFallback(relativePath, sourceText));
	}

	return [];
}

function clipText(text: string): string {
	return text.length > OUTLINE_INDEX_LIMITS.maxFileBytes
		? text.slice(0, OUTLINE_INDEX_LIMITS.maxFileBytes)
		: text;
}

// Доля outline entries по `source` (для IndexEngineStatus)
export function outlineSourceBreakdown(entries: OutlineEntry[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of entries) {
		const s = e.source ?? 'unknown';
		out[s] = (out[s] ?? 0) + 1;
	}
	return out;
}

// Пересобрать outline.json - тот же путь, что extractOutlineForFileAsync (сначала Tree-sitter)
export async function rebuildOutlineIndex(folder: vscode.WorkspaceFolder): Promise<OutlineDocument> {
	const files = await listIndexableFiles(folder);
	const entries: OutlineEntry[] = [];
	let fileCount = 0;

	for (const file of files) {
		if (entries.length >= OUTLINE_INDEX_LIMITS.maxEntries) {
			break;
		}

		if (fileCount >= OUTLINE_INDEX_LIMITS.maxFiles) {
			break;
		}

		if (!isOutlineablePath(file.relative)) {
			continue;
		}

		try {
			const text = await readIndexableText(file.uri);
			const clipped = text ? clipText(text) : undefined;
			const part = await extractOutlineForFileAsync(file.relative, file.uri, clipped);
			if (!isJsLikeOutlinePath(file.relative)) {
				await sleep(OUTLINE_INDEX_LIMITS.lspThrottleMs);
			}

			if (part.length === 0) {
				continue;
			}
			fileCount += 1;
			for (const e of part) {
				if (entries.length >= OUTLINE_INDEX_LIMITS.maxEntries) {
					break;
				}
				entries.push(e);
			}
		} catch {
			continue;
		}
	}

	const doc: OutlineDocument = {
		updatedAt: new Date().toISOString(),
		fileCount,
		entries,
	};
	await saveOutlineIndex(folder.uri.fsPath, doc);
	return doc;
}

export async function maybeRefreshOutlineIndex(folder: vscode.WorkspaceFolder): Promise<void> {
	if (getSettings().indexingEnabled === false) {
		return;
	}

	try {
		await rebuildOutlineIndex(folder);
	} catch {}
}

function emptyOutlineDoc(): OutlineDocument {
	return {
		updatedAt: new Date(0).toISOString(),
		fileCount: 0,
		entries: [],
	};
}

function isOutlineablePath(relative: string): boolean {
	return isJsLikeOutlinePath(relative) || isRegexOutlineFallbackPath(relative);
}

// Обновление одного файла в outline.json (без полного rebuild)
export async function updateOutlineIndexForFile(
	folder: vscode.WorkspaceFolder,
	relative: string,
	uri: vscode.Uri,
): Promise<void> {
	if (getSettings().indexingEnabled === false) {
		return;
	}

	const folderFs = folder.uri.fsPath;
	const prev = (await loadOutlineIndex(folderFs)) ?? emptyOutlineDoc();

	if (!isOutlineablePath(relative)) {
		if (prev.entries.some((e) => e.path === relative)) {
			await saveOutlineIndex(folderFs, applyOutlinePathRemove(prev, relative));
		}

		return;
	}

	let nextEntries: OutlineEntry[] = [];
	try {
		const text = await readIndexableText(uri);
		const clipped = text ? clipText(text) : undefined;
		nextEntries = await extractOutlineForFileAsync(relative, uri, clipped);
	} catch {
		nextEntries = [];
	}

	const next = applyOutlinePathUpdate(prev, relative, nextEntries, OUTLINE_INDEX_LIMITS.maxEntries);
	await saveOutlineIndex(folderFs, next);
}

// Удалить путь из outline.json
export async function removeOutlineIndexPath(
	folder: vscode.WorkspaceFolder,
	relative: string,
): Promise<void> {
	if (getSettings().indexingEnabled === false) {
		return;
	}

	const folderFs = folder.uri.fsPath;
	const prev = await loadOutlineIndex(folderFs);
	if (!prev?.entries.some((e) => e.path === relative)) {
		return;
	}

	await saveOutlineIndex(folderFs, applyOutlinePathRemove(prev, relative));
}

export async function findInOutlineIndex(
	query: string,
	maxResults: number,
): Promise<OutlineEntry[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (!folders.length) {
		return [];
	}

	const merged: OutlineEntry[] = [];
	for (const folder of folders) {
		const doc = await loadOutlineIndex(folder.uri.fsPath);
		if (doc?.entries.length) {
			merged.push(...doc.entries);
		}
	}
	if (!merged.length) {
		return [];
	}

	return searchOutlineEntries(query, merged, maxResults);
}
