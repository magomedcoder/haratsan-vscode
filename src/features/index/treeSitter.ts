/**
 * Runtime Tree-sitter wasm (`@vscode/tree-sitter-wasm`).
 * Field-правила, пул Parser, кэш spans, opt-in языки, метрики fail/timeout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';
import { contentHash } from './hash';
import { collectSpansFromTree, type TreeSitterSpanKind } from './treeSitterRules';

// MVP - всегда в whitelist VSIX
export const TREE_SITTER_MVP_LANGS = [
	'typescript',
	'tsx',
	'javascript',
	'python',
	'go',
	'rust',
	'java',
	'cpp',
	'c_sharp',
	'ruby',
	'php',
	'bash',
] as const;

/**
 * Opt-in сверх MVP.
 * `css` есть в `@vscode/tree-sitter-wasm`; kotlin/swift/... - reserved (wasm в пакет не входит, заработают после появления файла в dist/tree-sitter).
 */
export const TREE_SITTER_OPT_IN_LANGS = [
	'css',
	'html',
	'json',
	'yaml',
	'sql',
	'kotlin',
	'swift',
	'scala',
] as const;

export type TreeSitterMvpLangId = (typeof TREE_SITTER_MVP_LANGS)[number];
export type TreeSitterOptInLangId = (typeof TREE_SITTER_OPT_IN_LANGS)[number];
export type TreeSitterLangId = TreeSitterMvpLangId | TreeSitterOptInLangId;

export interface TreeSitterSpan {
	name: string;
	kind: TreeSitterSpanKind | string;
	startLine: number;
	endLine: number;
	startIndex: number;
	endIndex: number;
}

export type TreeSitterFailReason = | 'unavailable'
	| 'lang_disabled'
	| 'lang_unsupported'
	| 'wasm_missing'
	| 'oversized'
	| 'timeout'
	| 'error'
	| 'empty';

export interface TreeSitterParseResult {
	lang: TreeSitterLangId;
	spans: TreeSitterSpan[];
	source: 'treesitter';
	durationMs?: number;
}

export interface TreeSitterMetrics {
	ok: number;
	fail: number;
	timeout: number;
	oversized: number;
	cacheHit: number;
	byReason: Partial<Record<TreeSitterFailReason, number>>;
	lastError?: string;
}

const EXT_TO_LANG: Record<string, TreeSitterLangId> = {
	'.ts': 'typescript',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.tsx': 'tsx',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.py': 'python',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.cpp': 'cpp',
	'.cc': 'cpp',
	'.cxx': 'cpp',
	'.h': 'cpp',
	'.hpp': 'cpp',
	'.cs': 'c_sharp',
	'.rb': 'ruby',
	'.php': 'php',
	'.sh': 'bash',
	'.bash': 'bash',
	'.css': 'css',
	'.scss': 'css',
	'.html': 'html',
	'.htm': 'html',
	'.json': 'json',
	'.yaml': 'yaml',
	'.yml': 'yaml',
	'.sql': 'sql',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.swift': 'swift',
	'.scala': 'scala',
	'.sc': 'scala',
};

const LANG_WASM: Record<TreeSitterLangId, string> = {
	typescript: 'tree-sitter-typescript.wasm',
	tsx: 'tree-sitter-tsx.wasm',
	javascript: 'tree-sitter-javascript.wasm',
	python: 'tree-sitter-python.wasm',
	go: 'tree-sitter-go.wasm',
	rust: 'tree-sitter-rust.wasm',
	java: 'tree-sitter-java.wasm',
	cpp: 'tree-sitter-cpp.wasm',
	c_sharp: 'tree-sitter-c-sharp.wasm',
	ruby: 'tree-sitter-ruby.wasm',
	php: 'tree-sitter-php.wasm',
	bash: 'tree-sitter-bash.wasm',
	css: 'tree-sitter-css.wasm',
	html: 'tree-sitter-html.wasm',
	json: 'tree-sitter-json.wasm',
	yaml: 'tree-sitter-yaml.wasm',
	sql: 'tree-sitter-sql.wasm',
	kotlin: 'tree-sitter-kotlin.wasm',
	swift: 'tree-sitter-swift.wasm',
	scala: 'tree-sitter-scala.wasm',
};

export const TREE_SITTER_LIMITS = {
	maxFileBytes: 400_000,
	parseTimeoutMs: 2_000,
	maxCachedLanguages: 8,
	maxSpanCacheEntries: 64,
	maxParserPoolPerLang: 2,
} as const;

let wasmRoot: string | undefined;
let treeSitterApi: { Parser: any; Language: any } | undefined;
let initPromise: Promise<void> | undefined;

const languageCache = new Map<TreeSitterLangId, any>();
const languageLru: TreeSitterLangId[] = [];
const parserPool = new Map<TreeSitterLangId, any[]>();

interface SpanCacheEntry {
	hash: string;
	result: TreeSitterParseResult;
}
const spanCache = new Map<string, SpanCacheEntry>();

const metrics: TreeSitterMetrics = {
	ok: 0,
	fail: 0,
	timeout: 0,
	oversized: 0,
	cacheHit: 0,
	byReason: {},
};

let enabledLangsOverride: Set<TreeSitterLangId> | undefined;
let useWorkerPreferred = false;
let metricsFlushTimer: ReturnType<typeof setTimeout> | undefined;

export function resolveTreeSitterWasmRoot(extensionPath: string): string | undefined {
	const candidates = [
		path.join(extensionPath, 'dist', 'tree-sitter'),
		path.join(extensionPath, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
		extensionPath,
	];

	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, 'tree-sitter.wasm'))) {
			return dir;
		}
	}

	return undefined;
}

export function initTreeSitter(context: ExtensionContext): void {
	wasmRoot = resolveTreeSitterWasmRoot(context.extensionPath);
}

export function initTreeSitterFromPath(extensionOrWasmPath: string): void {
	wasmRoot = resolveTreeSitterWasmRoot(extensionOrWasmPath);
}

export function isTreeSitterAvailable(): boolean {
	return Boolean(wasmRoot);
}

export function getTreeSitterMetrics(): TreeSitterMetrics {
	return {
		...metrics,
		byReason: { ...metrics.byReason },
	};
}

export function resetTreeSitterMetricsForTests(): void {
	metrics.ok = 0;
	metrics.fail = 0;
	metrics.timeout = 0;
	metrics.oversized = 0;
	metrics.cacheHit = 0;
	metrics.byReason = {};
	metrics.lastError = undefined;
	spanCache.clear();
}

// Пустой / отсутствует = MVP; `*` / `all` = все доступные; иначе пересечение со списком
export function setTreeSitterLanguageAllowlist(langs: string[] | undefined): void {
	if (!langs || langs.length === 0) {
		enabledLangsOverride = undefined;
		return;
	}

	const lower = langs.map((l) => l.trim().toLowerCase()).filter(Boolean);
	if (lower.includes('*') || lower.includes('all')) {
		enabledLangsOverride = new Set(listAllTreeSitterLanguageIds());
		return;
	}

	const set = new Set<TreeSitterLangId>();
	for (const id of lower) {
		if (id in LANG_WASM) {
			set.add(id as TreeSitterLangId);
		}
	}

	enabledLangsOverride = set.size > 0 ? set : undefined;
}

export function setTreeSitterUseWorker(enabled: boolean): void {
	useWorkerPreferred = enabled;
}

export function listAllTreeSitterLanguageIds(): TreeSitterLangId[] {
	return Object.keys(LANG_WASM) as TreeSitterLangId[];
}

export function listSupportedTreeSitterLanguages(): TreeSitterLangId[] {
	return listAllTreeSitterLanguageIds().filter((id) => isLangWasmPresent(id));
}

export function listMvpTreeSitterLanguages(): TreeSitterLangId[] {
	return [...TREE_SITTER_MVP_LANGS];
}

function isLangWasmPresent(lang: TreeSitterLangId): boolean {
	if (!wasmRoot) {
		return false;
	}

	return fs.existsSync(path.join(wasmRoot, LANG_WASM[lang]));
}

function isLangEnabled(lang: TreeSitterLangId): boolean {
	if (!enabledLangsOverride) {
		return (TREE_SITTER_MVP_LANGS as readonly string[]).includes(lang);
	}

	return enabledLangsOverride.has(lang);
}

export function resolveTreeSitterLang(relativePath: string): TreeSitterLangId | undefined {
	const lower = relativePath.toLowerCase();
	const dot = lower.lastIndexOf('.');
	if (dot < 0) {
		return undefined;
	}

	const lang = EXT_TO_LANG[lower.slice(dot)];
	if (!lang) {
		return undefined;
	}

	if (!isLangEnabled(lang)) {
		return undefined;
	}

	return lang;
}

function recordFail(reason: TreeSitterFailReason, err?: string): void {
	metrics.fail += 1;
	metrics.byReason[reason] = (metrics.byReason[reason] ?? 0) + 1;
	if (reason === 'timeout') {
		metrics.timeout += 1;
	}

	if (reason === 'oversized') {
		metrics.oversized += 1;
	}

	if (err) {
		metrics.lastError = err.slice(0, 300);
	}

	scheduleMetricsFlush();
}

function recordOk(): void {
	metrics.ok += 1;
	scheduleMetricsFlush();
}

function scheduleMetricsFlush(): void {
	if (metricsFlushTimer) {
		return;
	}

	metricsFlushTimer = setTimeout(() => {
		metricsFlushTimer = undefined;
		void flushTreeSitterMetrics();
	}, 2_000);
}

async function flushTreeSitterMetrics(): Promise<void> {
	const snap = getTreeSitterMetrics();
	if (snap.ok + snap.fail === 0) {
		return;
	}

	const line = `treesitter: ok=${snap.ok} fail=${snap.fail} timeout=${snap.timeout}` +
		` oversized=${snap.oversized} cacheHit=${snap.cacheHit}` +
		(snap.lastError ? ` last=${snap.lastError}` : '');
	try {
		const { getSettings } = await import('../../core/config/settings');
		const { emitTreeSitterMetrics } = await import('../../core/llm/otel');
		emitTreeSitterMetrics(getSettings(), snap);
	} catch {}

	try {
		const mod = await import('../../core/stores/activityStore');
		mod.recordActivity({
			kind: 'tool',
			label: line,
			toolName: 'index_treesitter',
			status: snap.fail > snap.ok ? 'error' : 'ok',
		});
	} catch {}

	console.info(`[Haratsan] ${line}`);
}

async function ensureTreeSitterApi(): Promise<{ Parser: any; Language: any } | undefined> {
	if (!wasmRoot) {
		return undefined;
	}

	if (treeSitterApi) {
		return treeSitterApi;
	}

	if (!initPromise) {
		initPromise = (async () => {
			const root = wasmRoot!;
			const glue = path.join(root, 'tree-sitter.js');
			if (!fs.existsSync(glue)) {
				throw new Error('Нет tree-sitter.js в dist/tree-sitter');
			}

			const mod = require(glue) as {
				default?: any;
				Parser?: any;
				Language?: any;
				init?: (opts?: { locateFile?: (scriptName: string) => string }) => Promise<void>;
			};

			const Parser = mod.Parser ?? mod.default?.Parser ?? mod.default ?? mod;
			const Language = mod.Language ?? mod.default?.Language ?? Parser.Language;
			if (!Parser || !Language) {
				throw new Error('В tree-sitter нет экспортов Parser/Language');
			}

			const init = Parser.init?.bind(Parser) ?? mod.init;
			if (typeof init === 'function') {
				await init({
					locateFile: (scriptName: string) => path.join(root, path.basename(scriptName)),
				});
			}
			treeSitterApi = { Parser, Language };
		})().catch((err) => {
			initPromise = undefined;
			treeSitterApi = undefined;
			throw err;
		});
	}
	await initPromise;
	return treeSitterApi;
}

function touchLanguageLru(lang: TreeSitterLangId): void {
	const i = languageLru.indexOf(lang);
	if (i >= 0) {
		languageLru.splice(i, 1);
	}

	languageLru.push(lang);
	while (languageLru.length > TREE_SITTER_LIMITS.maxCachedLanguages) {
		const evict = languageLru.shift();
		if (!evict || evict === lang) {
			continue;
		}

		languageCache.delete(evict);
		const pooled = parserPool.get(evict);
		if (pooled) {
			for (const p of pooled) {
				try {
					p.delete?.();
				} catch {}
			}
			parserPool.delete(evict);
		}
	}
}

async function loadLanguage(lang: TreeSitterLangId): Promise<any | undefined> {
	if (languageCache.has(lang)) {
		touchLanguageLru(lang);
		return languageCache.get(lang);
	}

	const api = await ensureTreeSitterApi();
	if (!api || !wasmRoot) {
		return undefined;
	}

	const wasmFile = path.join(wasmRoot, LANG_WASM[lang]);
	if (!fs.existsSync(wasmFile)) {
		return undefined;
	}

	const language = await api.Language.load(wasmFile);
	languageCache.set(lang, language);
	touchLanguageLru(lang);
	return language;
}

function acquireParser(api: { Parser: any }, lang: TreeSitterLangId, language: any): any {
	const pool = parserPool.get(lang) ?? [];
	const parser = pool.pop() ?? new api.Parser();
	parser.setLanguage(language);
	parserPool.set(lang, pool);
	return parser;
}

function releaseParser(lang: TreeSitterLangId, parser: any): void {
	const pool = parserPool.get(lang) ?? [];
	if (pool.length < TREE_SITTER_LIMITS.maxParserPoolPerLang) {
		pool.push(parser);
		parserPool.set(lang, pool);
		return;
	}

	try {
		parser.delete?.();
	} catch {}
}

function cacheGet(relativePath: string, hash: string): TreeSitterParseResult | undefined {
	const hit = spanCache.get(relativePath);
	if (hit && hit.hash === hash) {
		metrics.cacheHit += 1;
		return hit.result;
	}

	return undefined;
}

function cacheSet(relativePath: string, hash: string, result: TreeSitterParseResult): void {
	spanCache.set(relativePath, { hash, result });
	if (spanCache.size > TREE_SITTER_LIMITS.maxSpanCacheEntries) {
		const first = spanCache.keys().next().value;
		if (first !== undefined) {
			spanCache.delete(first);
		}
	}
}

/**
 * Разобрать файл Tree-sitter.
 * При fail - `undefined` + метрика с причиной (не silent).
 */
export async function parseWithTreeSitter(
	relativePath: string,
	sourceText: string,
): Promise<TreeSitterParseResult | undefined> {
	if (!wasmRoot) {
		recordFail('unavailable');
		return undefined;
	}
	if (Buffer.byteLength(sourceText, 'utf8') > TREE_SITTER_LIMITS.maxFileBytes) {
		recordFail('oversized');
		return undefined;
	}

	const lower = relativePath.toLowerCase();
	const dot = lower.lastIndexOf('.');
	const rawLang = dot >= 0 ? EXT_TO_LANG[lower.slice(dot)] : undefined;
	if (!rawLang) {
		return undefined;
	}

	if (!isLangEnabled(rawLang)) {
		return undefined;
	}

	if (!isLangWasmPresent(rawLang)) {
		recordFail('wasm_missing', LANG_WASM[rawLang]);
		return undefined;
	}

	const hash = contentHash(sourceText);
	const cached = cacheGet(relativePath, hash);
	if (cached) {
		return cached;
	}

	// Опциональный worker: в VSIX wasm+Worker хрупко - уступаем цикл событий и парсим в том же процессе
	if (useWorkerPreferred) {
		await new Promise<void>((r) => setImmediate(r));
	}

	try {
		const api = await ensureTreeSitterApi();
		const language = await loadLanguage(rawLang);
		if (!api || !language) {
			recordFail('wasm_missing', LANG_WASM[rawLang]);
			return undefined;
		}

		const parser = acquireParser(api, rawLang, language);
		const started = Date.now();
		let timedOut = false;
		const tree = parser.parse(sourceText, undefined, {
			progressCallback: () => {
				if (Date.now() - started > TREE_SITTER_LIMITS.parseTimeoutMs) {
					timedOut = true;
					return true;
				}
				return false;
			},
		});

		if (timedOut || !tree?.rootNode) {
			try {
				tree?.delete?.();
			} catch {}
			releaseParser(rawLang, parser);
			recordFail(timedOut ? 'timeout' : 'empty');
			return undefined;
		}

		const spans = collectSpansFromTree(tree.rootNode, sourceText);
		tree.delete?.();
		releaseParser(rawLang, parser);

		const result: TreeSitterParseResult = {
			lang: rawLang,
			spans,
			source: 'treesitter',
			durationMs: Date.now() - started,
		};
		cacheSet(relativePath, hash, result);
		recordOk();
		return result;
	} catch (err) {
		recordFail('error', err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

// Имена wasm-файлов для esbuild / упаковки
export function treeSitterWasmFileNames(opts?: { includeOptInShipped?: boolean }): string[] {
	const names = new Set<string>(['tree-sitter.wasm', 'tree-sitter.js', 'web-tree-sitter.d.ts']);
	for (const id of TREE_SITTER_MVP_LANGS) {
		names.add(LANG_WASM[id]);
	}

	if (opts?.includeOptInShipped !== false) {
		// Только те opt-in, что реально есть в пакете VS Code (сейчас css)
		names.add(LANG_WASM.css);
	}
	
	return [...names];
}
