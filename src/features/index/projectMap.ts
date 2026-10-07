import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { mapDirForFolder, mapFilePath } from './indexStorage';
import { loadManifest } from './store';
import { listIndexableFiles, readIndexableText } from './scanner';
import { loadOutlineIndex } from './tsOutline';
import { summarizeOutlineForPath, type OutlineEntry } from './tsOutlineParse';
import type { IndexManifest } from './types';

export const PROJECT_MAP_LIMITS = {
	maxFiles: 2_000,
	defaultMaxDepth: 8,
	maxDepthCap: 20,
	maxSummaryLen: 120,
	maxOutputChars: 48_000,
	maxCommentPeekBytes: 512,
	maxCommentPeeks: 80,
} as const;

export type ProjectMapSource = 'index' | 'scan';

export interface ProjectMapNode {
	name: string;
	type: 'dir' | 'file';
	summary?: string;
	children?: ProjectMapNode[];
}

export interface ProjectMapDocument {
	updatedAt: string;
	source: ProjectMapSource;
	fileCount: number;
	maxDepth: number;
	truncated: boolean;
	tree: ProjectMapNode[];
}

export interface GetProjectMapOptions {
	refresh?: boolean;
	maxDepth?: number;
	folderFsPath?: string;
}

export interface ProjectMapResult {
	map: ProjectMapDocument;
	cached: boolean;
	outline: string;
	text: string;
}

const EXT_HINTS: Record<string, string> = {
	'.ts': 'TypeScript',
	'.tsx': 'React TSX',
	'.js': 'JavaScript',
	'.jsx': 'React JSX',
	'.mjs': 'JavaScript module',
	'.cjs': 'CommonJS',
	'.json': 'JSON',
	'.md': 'Markdown',
	'.css': 'CSS',
	'.scss': 'SCSS',
	'.html': 'HTML',
	'.py': 'Python',
	'.go': 'Go',
	'.rs': 'Rust',
	'.java': 'Java',
	'.kt': 'Kotlin',
	'.yml': 'YAML',
	'.yaml': 'YAML',
	'.toml': 'TOML',
	'.sh': 'Shell',
	'.sql': 'SQL',
};

function clipSummary(text: string, max = PROJECT_MAP_LIMITS.maxSummaryLen): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	if (oneLine.length <= max) {
		return oneLine;
	}

	return `${oneLine.slice(0, max - 1)}...`;
}

// Эвристика: basename + тип по расширению (+ опциональный комментарий)
export function heuristicFileSummary(relativePath: string, commentLine?: string): string {
	const base = path.posix.basename(relativePath);
	const ext = path.posix.extname(relativePath).toLowerCase();
	const hint = EXT_HINTS[ext] ?? (ext ? `${ext.slice(1)} file` : 'file');
	const core = `${base} - ${hint}`;
	if (!commentLine) {
		return clipSummary(core);
	}

	return clipSummary(`${core}: ${commentLine}`);
}

// Первая непустая строка-комментарий (дешёво, без AST)
export function extractCommentSummary(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) {
			continue;
		}

		if (line.startsWith('#!')) {
			continue;
		}

		if (line.startsWith('//')) {
			return clipSummary(line.slice(2).trim());
		}

		if (line.startsWith('#')) {
			return clipSummary(line.slice(1).trim());
		}

		if (line.startsWith('<!--')) {
			return clipSummary(line.replace(/^<!--\s*/, '').replace(/\s*-->$/, '').trim());
		}

		if (line.startsWith('/*') || line.startsWith('*')) {
			const cleaned = line
				.replace(/^\/\*+\s*/, '')
				.replace(/^\*\s*/, '')
				.replace(/\*\/\s*$/, '')
				.trim();
			if (cleaned) {
				return clipSummary(cleaned);
			}

			continue;
		}

		// Код начался - дальше не ищем
		break;
	}

	return undefined;
}

interface MutableNode {
	name: string;
	type: 'dir' | 'file';
	summary?: string;
	children?: Map<string, MutableNode>;
	fileCount: number;
}

function ensureChild(parent: MutableNode, name: string, type: 'dir' | 'file'): MutableNode {
	if (!parent.children) {
		parent.children = new Map();
	}

	let child = parent.children.get(name);
	if (!child) {
		child = {
			name,
			type,
			fileCount: 0,
		};
		parent.children.set(name, child);
	}

	return child;
}

/**
 * Построить дерево из плоских относительных путей.
 * `summaries` - опциональные one-line summary по полному relative path.
 */
export function buildTreeFromPaths(
	paths: string[],
	opts: {
		maxDepth: number;
		summaries?: Map<string, string>;
	},
): { tree: ProjectMapNode[]; truncated: boolean; fileCount: number } {
	const root: MutableNode = {
		name: '',
		type: 'dir',
		fileCount: 0,
	};
	let truncated = false;
	let fileCount = 0;

	const sorted = [...paths].sort((a, b) => a.localeCompare(b));
	for (const relative of sorted) {
		const parts = relative.split('/').filter(Boolean);
		if (parts.length === 0) {
			continue;
		}

		fileCount += 1;
		let node = root;
		for (let i = 0; i < parts.length; i++) {
			const isLast = i === parts.length - 1;
			const depth = i + 1;
			if (!isLast && depth > opts.maxDepth) {
				truncated = true;
				node.fileCount += 1;
				break;
			}

			if (isLast && depth > opts.maxDepth) {
				truncated = true;
				node.fileCount += 1;
				break;
			}

			const part = parts[i]!;
			const child = ensureChild(node, part, isLast ? 'file' : 'dir');
			if (isLast) {
				child.type = 'file';
				child.summary = opts.summaries?.get(relative) ?? heuristicFileSummary(relative);
				child.fileCount = 1;
			} else {
				child.type = 'dir';
			}

			node = child;
		}
	}

	function finalize(node: MutableNode, depth: number): ProjectMapNode {
		if (node.type === 'file') {
			return {
				name: node.name,
				type: 'file',
				summary: node.summary,
			};
		}

		const children: ProjectMapNode[] = [];
		let nestedFiles = 0;
		if (node.children) {
			const entries = [...node.children.values()].sort((a, b) => {
				if (a.type !== b.type) {
					return a.type === 'dir' ? -1 : 1;
				}

				return a.name.localeCompare(b.name);
			});

			for (const child of entries) {
				if (depth >= opts.maxDepth && child.type === 'dir') {
					truncated = true;
					const count = countFiles(child);
					nestedFiles += count;
					children.push({
						name: child.name,
						type: 'dir',
						summary: clipSummary(`${count} files (depth capped)`),
					});
					continue;
				}

				const fin = finalize(child, depth + 1);
				children.push(fin);
				nestedFiles += child.type === 'file' ? 1 : countFiles(child);
			}
		}

		nestedFiles += node.fileCount;
		const out: ProjectMapNode = {
			name: node.name,
			type: 'dir',
			children,
		};
		if (nestedFiles > 0 && node.name) {
			out.summary = clipSummary(`${nestedFiles} files`);
		}

		return out;
	}

	function countFiles(node: MutableNode): number {
		if (node.type === 'file') {
			return 1;
		}

		let n = node.fileCount;
		if (node.children) {
			for (const child of node.children.values()) {
				n += countFiles(child);
			}
		}

		return n;
	}

	const tree = finalize(root, 0).children ?? [];
	return { tree, truncated, fileCount };
}

// Текстовый outline для LLM (с отступами)
export function formatOutline(tree: ProjectMapNode[], indent = ''): string {
	const lines: string[] = [];
	for (const node of tree) {
		if (node.type === 'dir') {
			const label = node.summary ? `${node.name}/ - ${node.summary}` : `${node.name}/`;
			lines.push(`${indent}${label}`);
			if (node.children?.length) {
				lines.push(formatOutline(node.children, `${indent}  `));
			}
		} else {
			// summary уже содержит basename + hint
			lines.push(`${indent}${node.summary ?? node.name}`);
		}
	}

	return lines.filter(Boolean).join('\n');
}

export function isProjectMapStale(
	cached: ProjectMapDocument | undefined,
	indexUpdatedAt: string | undefined,
	outlineUpdatedAt?: string,
): boolean {
	if (!cached) {
		return true;
	}

	const cacheTs = Date.parse(cached.updatedAt);
	if (!Number.isFinite(cacheTs)) {
		return true;
	}

	if (indexUpdatedAt) {
		const indexTs = Date.parse(indexUpdatedAt);
		if (Number.isFinite(indexTs) && cacheTs < indexTs) {
			return true;
		}
	}

	if (outlineUpdatedAt) {
		const outlineTs = Date.parse(outlineUpdatedAt);
		if (Number.isFinite(outlineTs) && cacheTs < outlineTs) {
			return true;
		}
	}

	return false;
}

async function loadCachedMap(folderFsPath: string): Promise<ProjectMapDocument | undefined> {
	const file = mapFilePath(folderFsPath);
	if (!file) {
		return undefined;
	}

	try {
		const raw = await fs.readFile(file, 'utf8');
		const parsed = JSON.parse(raw) as ProjectMapDocument;
		if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tree)) {
			return undefined;
		}

		return parsed;
	} catch {
		return undefined;
	}
}

async function saveCachedMap(folderFsPath: string, doc: ProjectMapDocument): Promise<void> {
	const dir = mapDirForFolder(folderFsPath);
	const file = mapFilePath(folderFsPath);
	if (!dir || !file) {
		return;
	}
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
}

function mergeSummaryWithOutline(
	base: string,
	relative: string,
	outlineEntries?: OutlineEntry[],
): string {
	const outlineHint = outlineEntries?.length
		? summarizeOutlineForPath(outlineEntries, relative)
		: undefined;
	if (!outlineHint) {
		return base;
	}
	return clipSummary(`${base}; ${outlineHint}`);
}

function summariesFromManifest(
	manifest: IndexManifest,
	paths: string[],
	outlineEntries?: OutlineEntry[],
): Map<string, string> {
	const out = new Map<string, string>();
	for (const relative of paths) {
		const record = manifest.files[relative];
		let comment: string | undefined;
		if (record?.chunkIds?.length) {
			const chunk = manifest.chunks[record.chunkIds[0]!];
			if (chunk?.text) {
				comment = extractCommentSummary(chunk.text);
			}
		}

		const base = heuristicFileSummary(relative, comment);
		out.set(relative, mergeSummaryWithOutline(base, relative, outlineEntries));
	}

	return out;
}

async function summariesFromPeek(
	folder: vscode.WorkspaceFolder,
	paths: string[],
	outlineEntries?: OutlineEntry[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let peeks = 0;
	for (const relative of paths) {
		let comment: string | undefined;
		if (peeks < PROJECT_MAP_LIMITS.maxCommentPeeks) {
			const uri = vscode.Uri.joinPath(folder.uri, ...relative.split('/'));
			const text = await readIndexableText(uri);
			if (text !== undefined) {
				peeks += 1;
				const head = text.slice(0, PROJECT_MAP_LIMITS.maxCommentPeekBytes);
				comment = extractCommentSummary(head);
			}
		}

		const base = heuristicFileSummary(relative, comment);
		out.set(relative, mergeSummaryWithOutline(base, relative, outlineEntries));
	}

	return out;
}

function capOutput(result: ProjectMapResult): ProjectMapResult {
	if (result.text.length <= PROJECT_MAP_LIMITS.maxOutputChars) {
		return result;
	}

	const slim: ProjectMapDocument = {
		...result.map,
		truncated: true,
		tree: result.map.tree.slice(0, 40),
	};
	const outline = formatOutline(slim.tree);
	const payload = {
		...slim,
		cached: result.cached,
		outline: outline.slice(0, Math.floor(PROJECT_MAP_LIMITS.maxOutputChars * 0.6)),
		hint: 'Output truncated; use refresh + smaller max_depth or explore with glob/list_dir',
	};
	const text = JSON.stringify(payload, null, 2);
	return {
		map: slim,
		cached: result.cached,
		outline: payload.outline,
		text:
			text.length <= PROJECT_MAP_LIMITS.maxOutputChars
				? text
				: text.slice(0, PROJECT_MAP_LIMITS.maxOutputChars - 20) + '\n...\n}',
	};
}

/**
 * Карта модулей проекта: дерево + краткие summary, кэш в workspace storage (`map/<key>/project.json`).
 * Источник: файлы индекса (если есть) или workspace scan с ignore.
 */
export async function getProjectMap(opts: GetProjectMapOptions = {}): Promise<ProjectMapResult> {
	const folder =(opts.folderFsPath
		? vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === opts.folderFsPath)
		: undefined) ?? vscode.workspace.workspaceFolders?.[0];

	if (!folder) {
		throw new Error('Нет папки workspace');
	}

	const maxDepth = Math.min(
		Math.max(1, opts.maxDepth ?? PROJECT_MAP_LIMITS.defaultMaxDepth),
		PROJECT_MAP_LIMITS.maxDepthCap,
	);

	const folderFsPath = folder.uri.fsPath;
	const manifest = await loadManifest(folderFsPath);
	const indexUpdatedAt = manifest.updatedAt && Object.keys(manifest.files).length > 0 ? manifest.updatedAt : undefined;
	const outlineDoc = await loadOutlineIndex(folderFsPath);
	const outlineUpdatedAt = outlineDoc?.updatedAt;

	const cached = await loadCachedMap(folderFsPath);
	const stale =
		opts.refresh === true ||
		isProjectMapStale(cached, indexUpdatedAt, outlineUpdatedAt) ||
		(cached !== undefined && cached.maxDepth < maxDepth);

	if (cached && !stale) {
		const outline = formatOutline(cached.tree);
		return capOutput({
			map: cached,
			cached: true,
			outline,
			text: JSON.stringify(
				{
					...cached,
					cached: true,
					outline,
				},
				null,
				2,
			),
		});
	}

	const indexPaths = Object.keys(manifest.files).sort((a, b) => a.localeCompare(b));
	let source: ProjectMapSource;
	let paths: string[];
	let totalAvailable: number;
	let summaries: Map<string, string>;

	const outlineEntries = outlineDoc?.entries;

	if (indexPaths.length > 0) {
		source = 'index';
		totalAvailable = indexPaths.length;
		paths = indexPaths.slice(0, PROJECT_MAP_LIMITS.maxFiles);
		summaries = summariesFromManifest(manifest, paths, outlineEntries);
	} else {
		source = 'scan';
		const scanned = await listIndexableFiles(folder);
		totalAvailable = scanned.length;
		paths = scanned.map((f) => f.relative).slice(0, PROJECT_MAP_LIMITS.maxFiles);
		summaries = await summariesFromPeek(folder, paths, outlineEntries);
	}

	const built = buildTreeFromPaths(paths, { maxDepth, summaries });
	const doc: ProjectMapDocument = {
		updatedAt: new Date().toISOString(),
		source,
		fileCount: built.fileCount,
		maxDepth,
		truncated:
			built.truncated ||
			paths.length < totalAvailable ||
			built.fileCount >= PROJECT_MAP_LIMITS.maxFiles,
		tree: built.tree,
	};

	try {
		await saveCachedMap(folderFsPath, doc);
	} catch {}

	const outline = formatOutline(doc.tree);
	return capOutput({
		map: doc,
		cached: false,
		outline,
		text: JSON.stringify(
			{
				...doc,
				cached: false,
				outline,
			},
			null,
			2,
		),
	});
}
