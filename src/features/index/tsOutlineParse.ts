/**
 * Чистое извлечение outline TS/JS через TypeScript compiler API (`createSourceFile`).
 * Без зависимости от vscode - удобно для unit-тестов.
 */

import * as ts from 'typescript';

export type OutlineKind =
	| 'class'
	| 'interface'
	| 'type'
	| 'enum'
	| 'function'
	| 'method'
	| 'import'
	| 'variable'
	| 'namespace'
	| 'module'
	| 'field'
	| 'property'
	| 'macro';

export type OutlineSource = 'treesitter' | 'typescript' | 'lsp' | 'regex';

export interface OutlineEntry {
	name: string;
	kind: OutlineKind;
	path: string;
	startLine: number;
	endLine: number;
	containerName?: string;
	// Движок, породивший запись (outline.json)
	source?: OutlineSource;
}

export interface OutlineDocument {
	updatedAt: string;
	fileCount: number;
	entries: OutlineEntry[];
}

const JS_LIKE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

export function isJsLikeOutlinePath(relativePath: string): boolean {
	const lower = relativePath.toLowerCase();
	const dot = lower.lastIndexOf('.');
	if (dot < 0) {
		return false;
	}

	return JS_LIKE.has(lower.slice(dot));
}

function scriptKindForPath(relativePath: string): ts.ScriptKind {
	const lower = relativePath.toLowerCase();
	if (lower.endsWith('.tsx')) {
		return ts.ScriptKind.TSX;
	}

	if (lower.endsWith('.jsx')) {
		return ts.ScriptKind.JSX;
	}

	if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
		return ts.ScriptKind.JS;
	}

	return ts.ScriptKind.TS;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
	return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function pushEntry(
	out: OutlineEntry[],
	pathRel: string,
	sf: ts.SourceFile,
	node: ts.Node,
	name: string,
	kind: OutlineKind,
	containerName?: string,
): void {
	if (!name.trim()) {
		return;
	}
	out.push({
		name,
		kind,
		path: pathRel,
		startLine: lineOf(sf, node.getStart(sf, false)),
		endLine: lineOf(sf, node.end),
		containerName,
		source: 'typescript',
	});
}

function visitClassLike(
	out: OutlineEntry[],
	pathRel: string,
	sf: ts.SourceFile,
	node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
	kind: 'class' | 'interface',
): void {
	const name = node.name?.getText(sf) ?? '<anonymous>';
	pushEntry(out, pathRel, sf, node, name, kind);
	for (const member of node.members) {
		if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
			const mName = ts.isConstructorDeclaration(member)
				? 'constructor'
				: member.name?.getText(sf) ?? '<method>';
			pushEntry(out, pathRel, sf, member, mName, 'method', name);
		}
	}
}

/**
 * Извлечь outline class / function / import из текста одного файла (TS/JS).
 * Non-JS: LSP в `extractOutlineFromLsp` / regex-fallback - отдельно.
 */
export function parseTsOutline(relativePath: string, sourceText: string): OutlineEntry[] {
	if (!isJsLikeOutlinePath(relativePath)) {
		return [];
	}

	const sf = ts.createSourceFile(
		relativePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForPath(relativePath),
	);

	const out: OutlineEntry[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const mod = node.moduleSpecifier.getText(sf).replace(/^['"]|['"]$/g, '');
			const clause = node.importClause;
			if (clause?.name) {
				pushEntry(out, relativePath, sf, node, clause.name.getText(sf), 'import');
			}

			if (clause?.namedBindings) {
				if (ts.isNamespaceImport(clause.namedBindings)) {
					pushEntry(out, relativePath, sf, node, clause.namedBindings.name.getText(sf), 'import');
				} else if (ts.isNamedImports(clause.namedBindings)) {
					for (const el of clause.namedBindings.elements) {
						pushEntry(out, relativePath, sf, node, el.name.getText(sf), 'import');
					}
				}
			}

			if (!clause) {
				pushEntry(out, relativePath, sf, node, mod, 'import');
			}
			
			return;
		}

		if (ts.isClassDeclaration(node)) {
			visitClassLike(out, relativePath, sf, node, 'class');
			return;
		}

		if (ts.isInterfaceDeclaration(node)) {
			visitClassLike(out, relativePath, sf, node, 'interface');
			return;
		}

		if (ts.isTypeAliasDeclaration(node)) {
			pushEntry(out, relativePath, sf, node, node.name.getText(sf), 'type');
			return;
		}

		if (ts.isEnumDeclaration(node)) {
			pushEntry(out, relativePath, sf, node, node.name.getText(sf), 'enum');
			return;
		}

		if (ts.isFunctionDeclaration(node) && node.name) {
			pushEntry(out, relativePath, sf, node, node.name.getText(sf), 'function');
			return;
		}

		if (ts.isVariableStatement(node)) {
			for (const decl of node.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name)) {
					continue;
				}

				const init = decl.initializer;
				const isFn =
					!!init &&
					(ts.isArrowFunction(init) ||
						ts.isFunctionExpression(init) ||
						ts.isClassExpression(init));
				pushEntry(
					out,
					relativePath,
					sf,
					decl,
					decl.name.getText(sf),
					isFn ? 'function' : 'variable',
				);
			}
			return;
		}

		ts.forEachChild(node, visit);
	};

	visit(sf);
	return out;
}

// Минимальная форма DocumentSymbol для чистых тестов (vscode.SymbolKind - числа)
export interface LspOutlineSymbol {
	name: string;
	kind: number;
	range: {
		start: { line: number };
		end: { line: number };
	};
	children?: LspOutlineSymbol[];
}

// Минимальная форма SymbolInformation (плоский ответ LSP)
export interface LspOutlineSymbolInfo {
	name: string;
	kind: number;
	location: {
		range: {
			start: { line: number };
			end: { line: number };
		};
	};
	containerName?: string;
}

// Map vscode.SymbolKind -> OutlineKind. undefined для шума (file/string/literal), children всё равно обходим
export function mapLspSymbolKindToOutlineKind(kind: number): OutlineKind | undefined {
	switch (kind) {
		case 4: // Class
		case 22: // Struct
			return 'class';
		case 10: // Interface
			return 'interface';
		case 25: // TypeParameter
			return 'type';
		case 9: // Enum
			return 'enum';
		case 11: // Function
			return 'function';
		case 5: // Method
		case 8: // Constructor
			return 'method';
		case 6: // Property
			return 'property';
		case 7: // Field
			return 'field';
		case 12: // Variable
		case 13: // Constant
		case 21: // EnumMember
			return 'variable';
		case 1: // Module
		case 3: // Package
			return 'module';
		case 2: // Namespace
			return 'namespace';
		default:
			return undefined;
	}
}

// Предпочитаем LSP outline; regex только если LSP ничего не вернул
export function preferLspOrRegexOutline(
	lspEntries: OutlineEntry[],
	regexEntries: OutlineEntry[],
): OutlineEntry[] {
	return lspEntries.length > 0 ? lspEntries : regexEntries;
}

export function isRegexOutlineFallbackPath(relativePath: string): boolean {
	return /\.(py|go|rs|java|kt|rb)$/i.test(relativePath);
}

function pushLspOutlineEntry(
	out: OutlineEntry[],
	relativePath: string,
	name: string,
	kind: number,
	startLine0: number,
	endLine0: number,
	containerName: string | undefined,
	maxEntries: number,
): void {
	if (out.length >= maxEntries) {
		return;
	}

	const mapped = mapLspSymbolKindToOutlineKind(kind);
	if (!mapped || !name.trim()) {
		return;
	}

	out.push({
		name,
		kind: mapped,
		path: relativePath,
		startLine: startLine0 + 1,
		endLine: endLine0 + 1,
		containerName,
		source: 'lsp',
	});
}

// Раскрыть дерево DocumentSymbol -> OutlineEntry[] (pure; без vscode)
export function flattenLspDocumentSymbolsToOutline(
	symbols: LspOutlineSymbol[],
	relativePath: string,
	maxEntries: number = 12_000,
): OutlineEntry[] {
	const out: OutlineEntry[] = [];

	const walk = (items: LspOutlineSymbol[], containerName?: string): void => {
		for (const s of items) {
			if (out.length >= maxEntries) {
				return;
			}

			pushLspOutlineEntry(
				out,
				relativePath,
				s.name,
				s.kind,
				s.range.start.line,
				s.range.end.line,
				containerName,
				maxEntries,
			);

			if (s.children?.length) {
				walk(s.children, s.name);
			}
		}
	};

	walk(symbols);
	return out;
}

// Раскрыть SymbolInformation[] -> OutlineEntry[] (pure; без vscode)
export function flattenLspSymbolInfosToOutline(
	infos: LspOutlineSymbolInfo[],
	relativePath: string,
	maxEntries: number = 12_000,
): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	for (const s of infos) {
		if (out.length >= maxEntries) {
			break;
		}

		pushLspOutlineEntry(
			out,
			relativePath,
			s.name,
			s.kind,
			s.location.range.start.line,
			s.location.range.end.line,
			s.containerName,
			maxEntries,
		);
	}
	return out;
}

/**
 * Нормализовать результат executeDocumentSymbolProvider (DocumentSymbol[] | SymbolInformation[]).
 * Pure: принимает duck-typed формы.
 */
export function outlineEntriesFromLspProviderResult(
	result: unknown,
	relativePath: string,
	maxEntries: number = 12_000,
): OutlineEntry[] {
	if (!Array.isArray(result) || result.length === 0) {
		return [];
	}

	const first = result[0] as Record<string, unknown> | undefined;
	if (!first || typeof first !== 'object') {
		return [];
	}

	// DocumentSymbol: range + опциональные children; SymbolInformation: location
	if ('location' in first && first.location && typeof first.location === 'object') {
		return flattenLspSymbolInfosToOutline(
			result as LspOutlineSymbolInfo[],
			relativePath,
			maxEntries,
		);
	}

	if ('range' in first) {
		return flattenLspDocumentSymbolsToOutline(
			result as LspOutlineSymbol[],
			relativePath,
			maxEntries,
		);
	}

	return [];
}

// Дешёвый regex-запасной путь для не-TS языков (Python/Go-ish)
export function parseRegexOutlineFallback(relativePath: string, sourceText: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = sourceText.split(/\r?\n/);
	const patterns: Array<{ re: RegExp; kind: OutlineKind }> = [
		{ 
			re: /^\s*(?:export\s+)?(?:async\s+)?(?:def|fn|func|function)\s+([A-Za-z_][\w]*)/, 
			kind: 'function' 
		},
		{ 
			re: /^\s*(?:export\s+)?(?:class|interface|struct|trait|type)\s+([A-Za-z_][\w]*)/, 
			kind: 'class' 
		},
		{ 
			re: /^\s*(?:from\s+\S+\s+)?import\s+([A-Za-z_][\w.]*)/, 
			kind: 'import' 
		},
	];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]!;
		for (const { re, kind } of patterns) {
			const m = re.exec(line);
			if (m?.[1]) {
				out.push({
					name: m[1],
					kind,
					path: relativePath,
					startLine: i + 1,
					endLine: i + 1,
					source: 'regex',
				});
				break;
			}
		}
	}

	return out;
}

// Оценка релевантности для поиска по outline (−1 = нет совпадения)
export function scoreOutlineQuery(query: string, entry: OutlineEntry): number {
	const q = query.trim().toLowerCase();
	if (!q) {
		return 0;
	}

	const name = entry.name.toLowerCase();
	if (name === q) {
		return 1;
	}

	if (name.startsWith(q)) {
		return 0.85;
	}

	if (name.includes(q)) {
		return 0.6;
	}

	if (`${entry.kind} ${entry.name}`.toLowerCase().includes(q)) {
		return 0.4;
	}

	return -1;
}

export function searchOutlineEntries(
	query: string,
	entries: OutlineEntry[],
	maxResults: number,
): OutlineEntry[] {
	const q = query.trim();
	if (!q) {
		return entries.slice(0, maxResults);
	}

	const scored: Array<{ 
		e: OutlineEntry; 
		score: number 
	}> = [];
	for (const e of entries) {
		const score = scoreOutlineQuery(q, e);
		if (score >= 0) {
			scored.push({ e, score });
		}
	}
	scored.sort((a, b) => b.score - a.score || a.e.path.localeCompare(b.e.path));
	return scored.slice(0, maxResults).map((s) => s.e);
}

const OUTLINE_SUMMARY_KINDS = new Set<OutlineKind>([
	'class',
	'interface',
	'type',
	'enum',
	'function',
	'variable',
]);

// Однострочный hint экспорта для сводок project_map (записи outline TS/JS одного файла)
export function summarizeOutlineForPath(
	entries: OutlineEntry[],
	relativePath: string,
	maxNames = 4,
): string | undefined {
	const normalized = relativePath.replace(/\\/g, '/');
	const names: string[] = [];
	for (const e of entries) {
		if (e.path.replace(/\\/g, '/') !== normalized) {
			continue;
		}

		if (!OUTLINE_SUMMARY_KINDS.has(e.kind)) {
			continue;
		}

		if (names.includes(e.name)) {
			continue;
		}

		names.push(e.name);
		if (names.length >= maxNames) {
			break;
		}
	}
	if (names.length === 0) {
		return undefined;
	}

	const suffix = names.length >= maxNames ? ', ...' : '';
	return `exports: ${names.join(', ')}${suffix}`;
}

export function parseOutlineDocumentJson(raw: string): OutlineDocument | undefined {
	try {
		const parsed = JSON.parse(raw) as OutlineDocument;
		if (!parsed || !Array.isArray(parsed.entries)) {
			return undefined;
		}

		return {
			updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
			fileCount: typeof parsed.fileCount === 'number' ? parsed.fileCount : 0,
			entries: parsed.entries
				.filter((e) => e && typeof e.name === 'string' && typeof e.path === 'string')
				.map((e) => ({
					...e,
					source: e.source === 'treesitter' ||
							e.source === 'typescript' ||
							e.source === 'lsp' ||
							e.source === 'regex'
								? e.source
								: undefined,
				})),
		};
	} catch {
		return undefined;
	}
}

function recountOutlineFiles(entries: OutlineEntry[]): number {
	return new Set(entries.map((e) => e.path)).size;
}

// Инкрементально заменить entries одного файла (или убрать путь, если next пуст)
export function applyOutlinePathUpdate(
	doc: OutlineDocument,
	relative: string,
	nextEntries: OutlineEntry[],
	maxEntries: number,
): OutlineDocument {
	const kept = doc.entries.filter((e) => e.path !== relative);
	const merged = nextEntries.length > 0 ? [...kept, ...nextEntries] : kept;
	const entries = merged.slice(0, Math.max(0, maxEntries));
	return {
		updatedAt: new Date().toISOString(),
		fileCount: recountOutlineFiles(entries),
		entries,
	};
}

export function applyOutlinePathRemove(
	doc: OutlineDocument,
	relative: string,
): OutlineDocument {
	const entries = doc.entries.filter((e) => e.path !== relative);
	return {
		updatedAt: new Date().toISOString(),
		fileCount: recountOutlineFiles(entries),
		entries,
	};
}
