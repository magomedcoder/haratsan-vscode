import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { getSettings } from '../../../../core/config/settings';
import { semanticSearchWorkspace } from '../../../index/embeddings';
import { getIndexManager } from '../../../index/IndexManager';
import { findInSymbolIndex } from '../../../index/symbolIndex';
import { isProjectEnabled } from '../../../project/config';
import { AGENT_LIMITS, deniedDirectoryExcludeGlob } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { resolveWorkspacePath, throwIfAborted } from '../../workspacePath';
import { FIND_CODE_MAX_CHARS, mergeFindCodeHits, truncateFindCodeJson, type FindCodeRawHit } from './findCodeMerge';

export { FIND_CODE_MAX_CHARS, mergeFindCodeHits, truncateFindCodeJson } from './findCodeMerge';
export type { FindCodeMergedHit, FindCodeRawHit, FindCodeMergeBoosts } from './findCodeMerge';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_RESULTS = 12;

// Дешёвый список dirty путей (git status --porcelain)
async function listGitDirtyPaths(signal?: AbortSignal): Promise<string[]> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		return [];
	}

	try {
		const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-uall'], {
			cwd: root,
			timeout: 4_000,
			maxBuffer: 512_000,
			signal,
		});
		const out: string[] = [];
		for (const line of stdout.split(/\r?\n/)) {
			if (line.length < 4) {
				continue;
			}

			// XY PATH или XY ORIG -> PATH
			const rest = line.slice(3);
			const arrow = rest.indexOf(' -> ');
			const pathPart = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim().replace(/\\/g, '/');
			if (pathPart) {
				out.push(pathPart.replace(/^"|"$/g, ''));
			}
		}
		return out;
	} catch {
		return [];
	}
}

function recentEditorPaths(): string[] {
	const out: string[] = [];
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.uri.scheme !== 'file') {
			continue;
		}

		const rel = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/');
		if (rel && !rel.startsWith('.haratsan/')) {
			out.push(rel);
		}
	}

	return out;
}

export type FindCodeIntent = 'symbol' | 'path' | 'text' | 'mixed';

function parseIntent(raw: string): FindCodeIntent {
	const v = raw.trim().toLowerCase();
	if (v === 'symbol' || v === 'path' || v === 'text' || v === 'mixed') {
		return v;
	}

	return 'mixed';
}

function scorePathFuzzy(rel: string, query: string): number {
	const q = query.toLowerCase();
	const p = rel.toLowerCase();
	const base = p.split('/').pop() ?? p;
	if (base === q) {
		return 1;
	}

	if (base.startsWith(q)) {
		return Math.max(0.5, 0.9 - base.length / 500);
	}

	if (base.includes(q)) {
		return Math.max(0.35, 0.7 - base.length / 500);
	}

	if (p.includes(q)) {
		return Math.max(0.2, 0.5 - p.length / 800);
	}

	let ti = 0;
	for (const ch of p) {
		if (ch === q[ti]) {
			ti += 1;
			if (ti >= q.length) {
				return Math.max(0.1, 0.35 - p.length / 1000);
			}
		}
	}

	return -1;
}

function toGlobPattern(pattern: string): string {
	const trimmed = pattern.trim() || '**/*';
	if (/[*?\[]/.test(trimmed)) {
		return trimmed;
	}

	if (/\.[A-Za-z0-9]+$/.test(trimmed)) {
		return `**/${trimmed}`;
	}

	return `**/*${trimmed}*`;
}

type SourceResult = { hits: FindCodeRawHit[]; note?: string };

async function runFileSearch(query: string, cap: number, signal?: AbortSignal): Promise<SourceResult> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return { 
			hits: [], 
			note: 'file_search: нет workspace' 
		};
	}

	const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.haratsan}/**', 8000);
	const scored: FindCodeRawHit[] = [];
	for (const uri of uris) {
		throwIfAborted(signal);
		try {
			const rel = (await resolveWorkspacePath(uri.fsPath)).relative;
			const score = scorePathFuzzy(rel, query);
			if (score >= 0) {
				scored.push({
					path: rel,
					score,
					source: 'file_search',
					why: 'совпадение по имени/пути',
					snippet: rel,
				});
			}
		} catch {
			continue;
		}
	}
	scored.sort((a, b) => b.score - a.score);
	return { 
		hits: scored.slice(0, cap) 
	};
}

async function runGlob(query: string, cap: number, signal?: AbortSignal): Promise<SourceResult> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return { 
			hits: [], 
			note: 'glob: нет workspace' 
		};
	}

	const pattern = toGlobPattern(query);
	const exclude = deniedDirectoryExcludeGlob(getSettings().deniedPaths);
	const uris = await vscode.workspace.findFiles(pattern, exclude, cap);
	const hits: FindCodeRawHit[] = [];
	for (const uri of uris) {
		throwIfAborted(signal);
		try {
			const rel = (await resolveWorkspacePath(uri.fsPath)).relative;
			hits.push({
				path: rel,
				score: 0.75,
				source: 'glob',
				why: `glob ${pattern}`,
				snippet: rel,
			});
		} catch {
			continue;
		}
	}
	return { hits };
}

async function runGrep(query: string, cap: number, signal?: AbortSignal): Promise<SourceResult> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return { 
			hits: [], 
			note: 'grep: нет workspace' 
		};
	}

	const exclude = deniedDirectoryExcludeGlob(getSettings().deniedPaths);
	const uris = await vscode.workspace.findFiles('**/*', exclude, AGENT_LIMITS.maxSearchFiles);
	const matches: FindCodeRawHit[] = [];
	const q = query.toLowerCase();
	for (const uri of uris) {
		if (matches.length >= cap) {
			break;
		}

		throwIfAborted(signal);
		try {
			const resolved = await resolveWorkspacePath(uri.fsPath);
			const doc = await vscode.workspace.openTextDocument(uri);
			const text = doc.getText();
			if (text.length > AGENT_LIMITS.maxReadBytes) {
				continue;
			}

			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i += 1) {
				if (matches.length >= cap) {
					break;
				}

				const line = lines[i]!;
				if (line.toLowerCase().includes(q)) {
					matches.push({
						path: resolved.relative,
						line: i + 1,
						snippet: line.trim().slice(0, 200),
						score: 0.85,
						source: 'grep',
						why: 'текстовое совпадение',
					});
				}
			}
		} catch {
			continue;
		}
	}
	return { hits: matches };
}

async function runCodebase(query: string, cap: number, signal?: AbortSignal): Promise<SourceResult> {
	throwIfAborted(signal);
	const settings = getSettings();
	if (settings.indexForGrep === false || settings.indexingEnabled === false) {
		return { 
			hits: [], 
			note: 'codebase_search: индекс отключён' 
		};
	}

	const manager = getIndexManager();
	if (!manager) {
		return { 
			hits: [], 
			note: 'codebase_search: IndexManager не инициализирован' 
		};
	}

	if (!(await isProjectEnabled())) {
		return { 
			hits: [], 
			note: 'codebase_search: индекс проекта выключен' 
		};
	}

	const progress = manager.getProgress();
	if (progress.state === 'indexing') {
		return { 
			hits: [], 
			note: 'codebase_search: индекс ещё строится' 
		};
	}

	const hits = await manager.search(query, cap);
	const maxScore = Math.max(1, ...hits.map((h) => h.score), 1);
	return {
		hits: hits.map((h) => ({
			path: h.path,
			line: h.startLine,
			snippet: h.snippet.slice(0, 240),
			score: Math.min(1, h.score / maxScore) * 0.95,
			source: 'codebase_search',
			why: 'триграммный индекс',
		})),
	};
}

async function runSemantic(query: string, cap: number, signal?: AbortSignal): Promise<SourceResult> {
	const settings = getSettings();
	if (settings.indexingEnabled === false) {
		return { 
			hits: [], 
			note: 'semantic_search: индексирование отключено' 
		};
	}
	if (settings.indexForGrep === false) {
		return { 
			hits: [], 
			note: 'semantic_search: индекс отключён' 
		};
	}

	const mode = settings.localEmbeddingsMode;
	const hasRemote = !!(settings.embeddingsBaseUrl || settings.baseUrl);
	if (mode === 'off' && !hasRemote) {
		return { 
			hits: [], 
			note: 'semantic_search: нет embeddingsBaseUrl / baseUrl' 
		};
	}

	try {
		const hits = await semanticSearchWorkspace(query, {
			maxResults: cap,
			signal,
		});
		return {
			hits: hits.map((h) => ({
				path: h.path,
				snippet: (h.snippet ?? '').slice(0, 240),
				score: Math.max(0, Math.min(1, h.score)),
				source: 'semantic_search',
				why: h.source === 'trigram'
						? 'trigram fallback (localEmbeddingsMode)'
						: h.source === 'local-vector'
							? 'local vector index (feature hashing)'
							: 'семантическая близость (remote/cache)',
			})),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			 hits: [], 
			 note: `semantic_search: ${msg}` 
			};
	}
}

async function runSymbolIndex(query: string, cap: number, signal?: AbortSignal): Promise<SourceResult> {
	throwIfAborted(signal);
	try {
		const hits = await findInSymbolIndex(query, cap);
		if (hits.length === 0) {
			return { 
				hits: [], 
				note: 'symbol_index: пусто' 
			};
		}

		return {
			hits: hits.map((s) => ({
				path: s.path,
				line: s.startLine,
				snippet: `${s.kind} ${s.name}${s.containerName ? ` in ${s.containerName}` : ''}`,
				score: 0.92,
				source: 'symbol_index',
				why: 'LSP symbol cache',
			})),
		};
	} catch (err) {
		return { hits: [], note: `symbol_index: ${err instanceof Error ? err.message : String(err)}` };
	}
}

type FindCodeSource = | 'file_search'
	| 'glob'
	| 'grep'
	| 'codebase_search'
	| 'semantic_search'
	| 'symbol_index';

function sourcesForIntent(intent: FindCodeIntent): FindCodeSource[] {
	switch (intent) {
		case 'path':
			return ['file_search', 'glob'];
		case 'text':
			return ['grep', 'codebase_search'];
		case 'symbol':
			return ['symbol_index', 'grep', 'codebase_search', 'semantic_search'];
		case 'mixed':
		default:
			return ['file_search', 'glob', 'grep', 'codebase_search', 'semantic_search', 'symbol_index'];
	}
}

export const findCodeTool: ToolDefinition = {
	name: 'find_code',
	description: 'Гибридный поиск кода по намерению: внутри вызывает file_search/glob/grep/codebase_search/semantic_search и сливает результаты. Предпочтительный tool, когда нужно найти код по смыслу/имени/пути.',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Что искать: символ, фраза, путь, концепция',
			},
			intent: {
				type: 'string',
				enum: ['symbol', 'path', 'text', 'mixed'],
				description: 'Подсказка по типу поиска (по умолчанию mixed)',
			},
			max_results: {
				type: 'integer',
				description: `Лимит объединённых hits (по умолчанию ${DEFAULT_MAX_RESULTS})`,
			},
		},
		required: ['query'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const query = asString(args, 'query').trim();
		if (!query) {
			return {
				ok: false,
				content: 'find_code: нужен параметр query',
			};
		}

		const intent = parseIntent(asString(args, 'intent', 'mixed'));
		const maxResults = Math.min(
			Math.max(1, asOptionalInt(args, 'max_results') ?? DEFAULT_MAX_RESULTS),
			AGENT_LIMITS.maxSearchMatches,
		);

		// На каждый источник чуть больше, merge обрежет
		const perSource = Math.min(maxResults + 4, AGENT_LIMITS.maxSearchMatches);

		if (!vscode.workspace.workspaceFolders?.length) {
			return {
				ok: true,
				content: truncateFindCodeJson({
					query,
					intent,
					hits: [],
					notes: ['нет открытого workspace'],
					sourcesUsed: [],
				}, FIND_CODE_MAX_CHARS),
			};
		}

		const wanted = sourcesForIntent(intent);
		const runners: Array<Promise<SourceResult & { name: string }>> = wanted.map(async (name) => {
			throwIfAborted(ctx.signal);
			let result: SourceResult;
			switch (name) {
				case 'file_search':
					result = await runFileSearch(query, perSource, ctx.signal);
					break;
				case 'glob':
					result = await runGlob(query, perSource, ctx.signal);
					break;
				case 'grep':
					result = await runGrep(query, perSource, ctx.signal);
					break;
				case 'codebase_search':
					result = await runCodebase(query, perSource, ctx.signal);
					break;
				case 'semantic_search':
					result = await runSemantic(query, perSource, ctx.signal);
					break;
				case 'symbol_index':
					result = await runSymbolIndex(query, perSource, ctx.signal);
					break;
			}
			return { name, ...result };
		});

		const [settled, dirtyPaths] = await Promise.all([
			Promise.all(runners),
			listGitDirtyPaths(ctx.signal),
		]);
		const notes: string[] = [];
		const raw: FindCodeRawHit[] = [];
		const sourcesUsed: string[] = [];

		for (const part of settled) {
			if (part.note) {
				notes.push(part.note);
			}
			
			if (part.hits.length > 0) {
				sourcesUsed.push(part.name);
				raw.push(...part.hits);
			} else if (!part.note) {
				notes.push(`${part.name}: пусто`);
			}
		}

		const recentPaths = recentEditorPaths();
		const hits = mergeFindCodeHits(raw, maxResults, {
			dirtyPaths,
			recentPaths,
			pathQuery: query,
		});
		return {
			ok: true,
			content: truncateFindCodeJson({
				query,
				intent,
				sourcesUsed,
				notes,
				boosts: {
					dirtyCount: dirtyPaths.length,
					recentCount: recentPaths.length,
				},
				hits,
			}, FIND_CODE_MAX_CHARS),
		};
	},
};
