/**
 * Runtime Tree-sitter wasm (`@vscode/tree-sitter-wasm`).
 * Грамматики грузятся лениво; при ошибке - soft-fail, вызывающий код падает на LSP / typescript / regex.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';

export type TreeSitterLangId = | 'typescript'
	| 'tsx'
	| 'javascript'
	| 'python'
	| 'go'
	| 'rust'
	| 'java'
	| 'cpp'
	| 'c_sharp'
	| 'ruby'
	| 'php'
	| 'bash';

export interface TreeSitterSpan {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	startIndex: number;
	endIndex: number;
}

export interface TreeSitterParseResult {
	lang: TreeSitterLangId;
	spans: TreeSitterSpan[];
	source: 'treesitter';
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
};

// Типы узлов CST -> kind для outline/chunk (объединение по грамматикам)
const SPAN_NODE_KINDS: Record<string, string> = {
	function_declaration: 'function',
	function_definition: 'function',
	function_item: 'function',
	generator_function_declaration: 'function',
	arrow_function: 'function',
	method_declaration: 'method',
	method_definition: 'method',
	method_item: 'method',
	constructor_declaration: 'method',
	class_declaration: 'class',
	class_definition: 'class',
	class_specifier: 'class',
	interface_declaration: 'interface',
	type_alias_declaration: 'type',
	type_definition: 'type',
	type_declaration: 'type',
	type_spec: 'type',
	enum_declaration: 'enum',
	enum_item: 'enum',
	struct_item: 'class',
	struct_specifier: 'class',
	trait_item: 'interface',
	impl_item: 'class',
	lexical_declaration: 'variable',
	export_statement: 'variable',
};

export const TREE_SITTER_LIMITS = {
	maxFileBytes: 400_000,
	parseTimeoutMs: 2_000,
} as const;

let wasmRoot: string | undefined;
// Загруженные экспорты web-tree-sitter (`Parser`, `Language`, ...)
let treeSitterApi: { Parser: any; Language: any } | undefined;
let initPromise: Promise<void> | undefined;
const languageCache = new Map<TreeSitterLangId, any>();

// Найти каталог wasm: dist / node_modules / сам путь (для тестов)
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

// Тесты / tooling: задать wasm root без ExtensionContext
export function initTreeSitterFromPath(extensionOrWasmPath: string): void {
	wasmRoot = resolveTreeSitterWasmRoot(extensionOrWasmPath);
}

export function isTreeSitterAvailable(): boolean {
	return Boolean(wasmRoot);
}

export function resolveTreeSitterLang(relativePath: string): TreeSitterLangId | undefined {
	const lower = relativePath.toLowerCase();
	const dot = lower.lastIndexOf('.');
	if (dot < 0) {
		return undefined;
	}

	return EXT_TO_LANG[lower.slice(dot)];
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

async function loadLanguage(lang: TreeSitterLangId): Promise<any | undefined> {
	if (languageCache.has(lang)) {
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
	return language;
}

function nodeName(node: any, source: string): string {
	const nameNode =
		node.childForFieldName?.('name') ??
		node.childForFieldName?.('declarator') ??
		node.children?.find?.((c: any) => c?.type === 'identifier' || c?.type === 'type_identifier' || c?.type === 'property_identifier');
	if (nameNode && typeof nameNode.startIndex === 'number' && typeof nameNode.endIndex === 'number') {
		return source.slice(nameNode.startIndex, nameNode.endIndex) || node.type;
	}
	
	// lexical_declaration: первый identifier в поддереве
	if (node.type === 'lexical_declaration' || node.type === 'export_statement') {
		const walk: any[] = [...(node.children ?? [])];
		while (walk.length) {
			const n = walk.shift();
			if (!n) {
				continue;
			}
			
			if (n.type === 'identifier' || n.type === 'property_identifier') {
				return source.slice(n.startIndex, n.endIndex);
			}
			
			if (n.children?.length) {
				walk.push(...n.children);
			}
		}
	}

	return node.type;
}

function collectSpans(root: any, source: string): TreeSitterSpan[] {
	const out: TreeSitterSpan[] = [];
	const visit = (node: any, depth: number): void => {
		if (!node || depth > 64) {
			return;
		}

		const kind = SPAN_NODE_KINDS[node.type];
		if (kind && typeof node.startIndex === 'number') {
			const startLine = (node.startPosition?.row ?? 0) + 1;
			const endLine = (node.endPosition?.row ?? 0) + 1;
			out.push({
				name: nodeName(node, source),
				kind,
				startLine,
				endLine,
				startIndex: node.startIndex,
				endIndex: node.endIndex,
			});
		}

		const children = node.children ?? node.namedChildren ?? [];
		for (const child of children) {
			visit(child, depth + 1);
		}
	};

	visit(root, 0);
	// Убрать дубликаты одинаковых span
	const seen = new Set<string>();
	return out.filter((s) => {
		const key = `${s.kind}:${s.name}:${s.startLine}:${s.endLine}`;
		if (seen.has(key)) {
			return false;
		}
		
		seen.add(key);
		return true;
	});
}

/**
 * Разобрать файл Tree-sitter. 
 * `undefined` если wasm недоступен / ошибка / timeout / файл слишком большой.
 */
export async function parseWithTreeSitter(
	relativePath: string,
	sourceText: string,
): Promise<TreeSitterParseResult | undefined> {
	if (!wasmRoot) {
		return undefined;
	}

	if (Buffer.byteLength(sourceText, 'utf8') > TREE_SITTER_LIMITS.maxFileBytes) {
		return undefined;
	}

	const lang = resolveTreeSitterLang(relativePath);
	if (!lang) {
		return undefined;
	}

	try {
		const api = await ensureTreeSitterApi();
		const language = await loadLanguage(lang);
		if (!api || !language) {
			return undefined;
		}

		const parser = new api.Parser();
		parser.setLanguage(language);

		const started = Date.now();
		const tree = parser.parse(sourceText, undefined, {
			progressCallback: () => Date.now() - started > TREE_SITTER_LIMITS.parseTimeoutMs,
		});
		if (!tree?.rootNode) {
			parser.delete?.();
			return undefined;
		}
		
		const spans = collectSpans(tree.rootNode, sourceText);
		tree.delete?.();
		parser.delete?.();
		return { lang, spans, source: 'treesitter' };
	} catch {
		return undefined;
	}
}

export function listSupportedTreeSitterLanguages(): TreeSitterLangId[] {
	return Object.keys(LANG_WASM) as TreeSitterLangId[];
}
