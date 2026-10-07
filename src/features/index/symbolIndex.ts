import * as fs from 'node:fs/promises';
import type * as vscodeTypes from 'vscode';
import { getSettings } from '../../core/config/settings';
import { INDEX_SYMBOLS_FILE, indexDirForFolder, indexFilePath } from './indexStorage';
import { loadManifest } from './store';
import { parseSymbolIndexJson, applySymbolPathRemove, applySymbolPathUpdate, type SymbolIndexDocument, type SymbolIndexEntry } from './symbolIndexParse';

export type { SymbolIndexDocument, SymbolIndexEntry } from './symbolIndexParse';
export { parseSymbolIndexJson, applySymbolPathRemove, applySymbolPathUpdate } from './symbolIndexParse';

export const SYMBOL_INDEX_LIMITS = {
	maxFiles: 200,
	throttleMs: 40,
	maxSymbols: 8_000,
	staleMs: 15 * 60_000,
} as const;

// vscode.SymbolKind numeric values (без require('vscode') на parse-пути)
const KIND_NAMES: Record<number, string> = {
	0: 'file',
	1: 'module',
	2: 'namespace',
	3: 'package',
	4: 'class',
	5: 'method',
	6: 'property',
	7: 'field',
	8: 'constructor',
	9: 'enum',
	10: 'interface',
	11: 'function',
	12: 'variable',
	13: 'constant',
	14: 'string',
	15: 'number',
	16: 'boolean',
	17: 'array',
	18: 'object',
	19: 'key',
	20: 'null',
	21: 'enumMember',
	22: 'struct',
	23: 'event',
	24: 'operator',
	25: 'typeParameter',
};

function kindName(kind: number): string {
	return KIND_NAMES[kind] ?? `kind:${kind}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function symbolsPathForFolder(folderFsPath: string): string | undefined {
	return indexFilePath(folderFsPath, INDEX_SYMBOLS_FILE);
}

export async function loadSymbolIndex(folderFsPath: string): Promise<SymbolIndexDocument | undefined> {
	const file = symbolsPathForFolder(folderFsPath);
	if (!file) {
		return undefined;
	}

	try {
		const raw = await fs.readFile(file, 'utf8');
		return parseSymbolIndexJson(raw);
	} catch {
		return undefined;
	}
}

async function writeSymbolIndex(folderFsPath: string, doc: SymbolIndexDocument): Promise<void> {
	const dir = indexDirForFolder(folderFsPath);
	const file = symbolsPathForFolder(folderFsPath);
	if (!dir || !file) {
		return;
	}
	
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
}

function flattenSymbols(
	items: vscodeTypes.DocumentSymbol[],
	relative: string,
	out: SymbolIndexEntry[],
	containerName?: string,
): void {
	for (const s of items) {
		if (out.length >= SYMBOL_INDEX_LIMITS.maxSymbols) {
			return;
		}

		out.push({
			name: s.name,
			kind: kindName(s.kind as number),
			path: relative,
			startLine: s.range.start.line + 1,
			endLine: s.range.end.line + 1,
			containerName,
		});

		if (s.children?.length) {
			flattenSymbols(s.children, relative, out, s.name);
		}
	}
}

let building = false;

async function loadVscode(): Promise<typeof import('vscode')> {
	return import('vscode');
}

// LSP-backed symbol index (без Tree-sitter): vscode.executeDocumentSymbolProvider по файлам из manifest, с throttle и cap.
export async function buildSymbolIndex(
	folder: vscodeTypes.WorkspaceFolder,
	opts?: { signal?: AbortSignal; maxFiles?: number },
): Promise<SymbolIndexDocument> {
	const vscode = await loadVscode();
	const folderFs = folder.uri.fsPath;
	const manifest = await loadManifest(folderFs);
	const maxFiles = opts?.maxFiles ?? SYMBOL_INDEX_LIMITS.maxFiles;
	const paths = Object.keys(manifest.files).sort().slice(0, maxFiles);
	const symbols: SymbolIndexEntry[] = [];

	for (const relative of paths) {
		if (opts?.signal?.aborted) {
			break;
		}

		if (symbols.length >= SYMBOL_INDEX_LIMITS.maxSymbols) {
			break;
		}

		const uri = vscode.Uri.joinPath(folder.uri, ...relative.split('/'));
		try {
			const docSymbols = await vscode.commands.executeCommand<vscodeTypes.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				uri,
			);
			if (docSymbols?.length) {
				flattenSymbols(docSymbols, relative, symbols);
			}
		} catch {}

		await sleep(SYMBOL_INDEX_LIMITS.throttleMs);
	}

	const doc: SymbolIndexDocument = {
		updatedAt: new Date().toISOString(),
		fileCount: paths.length,
		symbols,
	};

	await writeSymbolIndex(folderFs, doc);
	return doc;
}

// Фоновый refresh после полной индексации (не чаще чем stale)
export async function maybeRefreshSymbolIndex(folder: vscodeTypes.WorkspaceFolder): Promise<void> {
	if (getSettings().indexingEnabled === false) {
		return;
	}

	if (building) {
		return;
	}

	const existing = await loadSymbolIndex(folder.uri.fsPath);
	if (existing) {
		const age = Date.now() - new Date(existing.updatedAt).getTime();
		if (Number.isFinite(age) && age >= 0 && age < SYMBOL_INDEX_LIMITS.staleMs) {
			return;
		}
	}

	building = true;
	try {
		await buildSymbolIndex(folder);
	} catch {
		// тихо: symbol index - best-effort
	} finally {
		building = false;
	}
}

function emptySymbolDoc(): SymbolIndexDocument {
	return {
		updatedAt: new Date(0).toISOString(),
		fileCount: 0,
		symbols: [],
	};
}

async function saveSymbolDoc(folderFs: string, doc: SymbolIndexDocument): Promise<void> {
	await writeSymbolIndex(folderFs, doc);
}

// Per-file upsert в symbols.json через LSP DocumentSymbolProvider
export async function updateSymbolIndexForFile(
	folder: vscodeTypes.WorkspaceFolder,
	relative: string,
	uri: vscodeTypes.Uri,
): Promise<void> {
	if (getSettings().indexingEnabled === false) {
		return;
	}

	const vscode = await loadVscode();
	const folderFs = folder.uri.fsPath;
	const prev = (await loadSymbolIndex(folderFs)) ?? emptySymbolDoc();
	const nextSymbols: SymbolIndexEntry[] = [];

	try {
		const docSymbols = await vscode.commands.executeCommand<vscodeTypes.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			uri,
		);
		if (docSymbols?.length) {
			flattenSymbols(docSymbols, relative, nextSymbols);
		}
	} catch {}

	const next = applySymbolPathUpdate(prev, relative, nextSymbols, SYMBOL_INDEX_LIMITS.maxSymbols);
	await saveSymbolDoc(folderFs, next);
}

export async function removeSymbolIndexPath(
	folder: vscodeTypes.WorkspaceFolder,
	relative: string,
): Promise<void> {
	if (getSettings().indexingEnabled === false) {
		return;
	}

	const folderFs = folder.uri.fsPath;
	const prev = await loadSymbolIndex(folderFs);
	if (!prev?.symbols.some((s) => s.path === relative)) {
		return;
	}

	await saveSymbolDoc(folderFs, applySymbolPathRemove(prev, relative));
}

function scoreSymbol(entry: SymbolIndexEntry, query: string): number {
	const q = query.toLowerCase();
	const name = entry.name.toLowerCase();
	if (name === q) {
		return 1;
	}

	if (name.startsWith(q)) {
		return 0.85;
	}

	if (name.includes(q)) {
		return 0.65;
	}

	if (entry.path.toLowerCase().includes(q)) {
		return 0.35;
	}

	if (entry.containerName?.toLowerCase().includes(q)) {
		return 0.3;
	}

	return -1;
}

export async function findInSymbolIndex(
	query: string,
	maxResults: number,
	folderFsPath?: string,
): Promise<SymbolIndexEntry[]> {
	const vscode = await loadVscode();
	const folder = folderFsPath
		?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) {
		return [];
	}

	let doc = await loadSymbolIndex(folder);
	if (!doc) {
		const wf = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === folder)
			?? vscode.workspace.workspaceFolders?.[0];
		if (wf) {
			try {
				doc = await buildSymbolIndex(wf);
			} catch {
				return [];
			}
		}
	}

	if (!doc) {
		return [];
	}

	const q = query.trim();
	if (!q) {
		return doc.symbols.slice(0, maxResults);
	}

	const scored = doc.symbols
		.map((s) => ({ s, score: scoreSymbol(s, q) }))
		.filter((x) => x.score >= 0)
		.sort((a, b) => b.score - a.score || a.s.path.localeCompare(b.s.path));

	return scored.slice(0, Math.max(1, maxResults)).map((x) => x.s);
}

// Краткий summary для @symbols mention
export async function formatSymbolIndexSummary(query?: string): Promise<string> {
	const vscode = await loadVscode();
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return '[symbols] нет workspace';
	}

	const q = query?.trim();
	if (q) {
		const hits = await findInSymbolIndex(q, 40, folder.uri.fsPath);
		if (hits.length === 0) {
			return `[symbols] ничего не найдено по «${q}»`;
		}

		const lines = hits.map(
			(s) => `- ${s.kind} ${s.name}${s.containerName ? ` (${s.containerName})` : ''} @ ${s.path}:${s.startLine}`,
		);
		return `[symbols ${q}]\n${lines.join('\n')}`.slice(0, 12_000);
	}

	const doc = await loadSymbolIndex(folder.uri.fsPath);
	if (!doc || doc.symbols.length === 0) {
		void maybeRefreshSymbolIndex(folder);
		return '[symbols] индекс символов пуст или ещё строится (LSP). Вызови find_symbol или подожди индексацию.';
	}

	const byKind = new Map<string, number>();
	for (const s of doc.symbols) {
		byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
	}

	const kindLines = [...byKind.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([k, n]) => `  ${k}: ${n}`);
	const sample = doc.symbols.slice(0, 30).map(
		(s) => `- ${s.kind} ${s.name} @ ${s.path}:${s.startLine}`,
	);

	return [
		`[symbols] ${doc.symbols.length} символов, ${doc.fileCount} файлов (updated ${doc.updatedAt})`,
		'по kinds:',
		...kindLines,
		'sample:',
		...sample,
	].join('\n').slice(0, 12_000);
}
