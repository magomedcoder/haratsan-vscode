/**
 * Явные field-правила CST -> span (вместо плоского SPAN_NODE_KINDS).
 * Имена через childForFieldName; export_statement не эмитится; lexical - только top-level / named fn.
 */

export type TreeSitterSpanKind = | 'function'
	| 'method'
	| 'class'
	| 'interface'
	| 'type'
	| 'enum'
	| 'variable'
	| 'namespace'
	| 'module'
	| 'field'
	| 'property'
	| 'macro';

export interface SpanRule {
	type: string;
	kind: TreeSitterSpanKind;
	nameFields?: string[];
	requireName?: boolean;
	skipAnonymous?: boolean;
	// Макс. глубина узла (0 = корень документа)
	maxDepth?: number;
}

export const SPAN_RULES: readonly SpanRule[] = [
	{ type: 'function_declaration', kind: 'function', nameFields: ['name'], requireName: true },
	{ type: 'function_definition', kind: 'function', nameFields: ['name'], requireName: true },
	{ type: 'function_item', kind: 'function', nameFields: ['name'], requireName: true },
	{ type: 'generator_function_declaration', kind: 'function', nameFields: ['name'], requireName: true },
	{ type: 'arrow_function', kind: 'function', nameFields: ['name'], requireName: true, skipAnonymous: true },
	{ type: 'method_declaration', kind: 'method', nameFields: ['name'], requireName: true },
	{ type: 'method_definition', kind: 'method', nameFields: ['name'], requireName: true },
	{ type: 'method_item', kind: 'method', nameFields: ['name'], requireName: true },
	{ type: 'constructor_declaration', kind: 'method', nameFields: ['name'] },
	{ type: 'class_declaration', kind: 'class', nameFields: ['name'], requireName: true },
	{ type: 'class_definition', kind: 'class', nameFields: ['name'], requireName: true },
	{ type: 'class_specifier', kind: 'class', nameFields: ['name'], requireName: true },
	// Ruby: узлы `class` / `method` (не class_declaration)
	{ type: 'class', kind: 'class', nameFields: ['name'], requireName: true },
	{ type: 'method', kind: 'method', nameFields: ['name'], requireName: true },
	{ type: 'interface_declaration', kind: 'interface', nameFields: ['name'], requireName: true },
	{ type: 'trait_item', kind: 'interface', nameFields: ['name'], requireName: true },
	{ type: 'type_alias_declaration', kind: 'type', nameFields: ['name'], requireName: true },
	{ type: 'type_definition', kind: 'type', nameFields: ['name'], requireName: true },
	{ type: 'type_declaration', kind: 'type', nameFields: ['name'], requireName: true },
	{ type: 'type_spec', kind: 'type', nameFields: ['name'], requireName: true },
	{ type: 'enum_declaration', kind: 'enum', nameFields: ['name'], requireName: true },
	{ type: 'enum_item', kind: 'enum', nameFields: ['name'], requireName: true },
	{ type: 'struct_item', kind: 'class', nameFields: ['name'], requireName: true },
	{ type: 'struct_specifier', kind: 'class', nameFields: ['name'], requireName: true },
	{ type: 'impl_item', kind: 'class', nameFields: ['type'], requireName: true },
	{ type: 'namespace_definition', kind: 'namespace', nameFields: ['name'], requireName: true },
	{ type: 'namespace_declaration', kind: 'namespace', nameFields: ['name'], requireName: true },
	{ type: 'module', kind: 'module', nameFields: ['name'], requireName: true },
	{ type: 'module_declaration', kind: 'module', nameFields: ['name'], requireName: true },
	{ type: 'field_declaration', kind: 'field', nameFields: ['name', 'declarator'], requireName: true },
	{ type: 'field_definition', kind: 'field', nameFields: ['name'], requireName: true },
	{ type: 'property_declaration', kind: 'property', nameFields: ['name'], requireName: true },
	{ type: 'property_signature', kind: 'property', nameFields: ['name'], requireName: true },
	{ type: 'macro_definition', kind: 'macro', nameFields: ['name'], requireName: true },
	{ type: 'macro_rules_definition', kind: 'macro', nameFields: ['name'], requireName: true },
	{ type: 'preproc_function_def', kind: 'macro', nameFields: ['name'], requireName: true },
	{ type: 'lexical_declaration', kind: 'variable', nameFields: ['name'], requireName: true, maxDepth: 2 },
	// CSS: наборы правил
	{ type: 'rule_set', kind: 'type', nameFields: ['name'], requireName: false },
];

const RULE_BY_TYPE = new Map(SPAN_RULES.map((r) => [r.type, r]));

const NAME_NODE_TYPES = new Set([
	'identifier',
	'type_identifier',
	'property_identifier',
	'name',
	'constant',
	'symbol',
	'class_name',
	'tag_name',
	'word', // имя функции в bash
]);

export function ruleForNodeType(type: string): SpanRule | undefined {
	return RULE_BY_TYPE.get(type);
}

function sliceName(node: any, source: string): string | undefined {
	if (!node || typeof node.startIndex !== 'number' || typeof node.endIndex !== 'number') {
		return undefined;
	}

	const t = source.slice(node.startIndex, node.endIndex).trim();
	return t || undefined;
}

function walkFirstIdentifier(node: any, source: string): string | undefined {
	const walk: any[] = [node];
	while (walk.length) {
		const n = walk.shift();
		if (!n) {
			continue;
		}

		if (NAME_NODE_TYPES.has(n.type) || n.type?.endsWith?.('identifier')) {
			const name = sliceName(n, source);
			if (name && name.length <= 200) {
				return name;
			}
		}

		const kids = n.namedChildren ?? n.children ?? [];
		for (const c of kids) {
			walk.push(c);
		}
	}

	return undefined;
}

// Имя узла по field-правилам
export function extractNodeName(node: any, source: string, rule: SpanRule): string | undefined {
	if (node.type === 'constructor_declaration') {
		return 'constructor';
	}

	const fields = rule.nameFields ?? ['name'];
	for (const field of fields) {
		const child = node.childForFieldName?.(field);
		if (child) {
			const direct = sliceName(child, source);
			// Имя из field - принимать и leaf без «identifier» в type (bash `word`)
			if (direct && !direct.includes('\n') && direct.length <= 200) {
				if (
					NAME_NODE_TYPES.has(child.type) ||
					child.type?.endsWith?.('identifier') ||
					(child.childCount ?? child.children?.length ?? 0) === 0
				) {
					return direct;
				}
			}

			const nested = walkFirstIdentifier(child, source);
			if (nested) {
				return nested;
			}
		}
	}

	if (node.type === 'lexical_declaration') {
		return undefined; // обрабатывается отдельно (fn vs variable)
	}

	return walkFirstIdentifier(node, source);
}

export interface CollectedSpan {
	name: string;
	kind: TreeSitterSpanKind;
	startLine: number;
	endLine: number;
	startIndex: number;
	endIndex: number;
}

function pushSpan(out: CollectedSpan[], node: any, name: string, kind: TreeSitterSpanKind): void {
	if (!name || name.length > 200) {
		return;
	}

	out.push({
		name,
		kind,
		startLine: (node.startPosition?.row ?? 0) + 1,
		endLine: (node.endPosition?.row ?? 0) + 1,
		startIndex: node.startIndex,
		endIndex: node.endIndex,
	});
}

// Собрать spans + фильтр вложенных function внутри function/method (методы внутри class сохраняются)
export function collectSpansFromTree(root: any, source: string): CollectedSpan[] {
	const raw: CollectedSpan[] = [];

	const visit = (node: any, depth: number): void => {
		if (!node || depth > 64) {
			return;
		}

		// export_statement - только дети (не variable на весь export)
		if (node.type === 'export_statement') {
			for (const child of node.namedChildren ?? node.children ?? []) {
				visit(child, depth + 1);
			}
			return;
		}

		// const foo = () => {} / function
		if (node.type === 'lexical_declaration' && depth <= 2) {
			for (const c of node.namedChildren ?? node.children ?? []) {
				if (c?.type !== 'variable_declarator') {
					continue;
				}

				const id = c.childForFieldName?.('name');
				const init = c.childForFieldName?.('value') ?? c.childForFieldName?.('init');
				const fname = sliceName(id, source);
				if (
					fname &&
					init &&
					(init.type === 'arrow_function' ||
						init.type === 'function' ||
						init.type === 'function_expression' ||
						init.type === 'generator_function')
				) {
					pushSpan(raw, c, fname, 'function');
				} else if (fname && !init?.type?.includes('function')) {
					pushSpan(raw, c, fname, 'variable');
				}
			}

			for (const child of node.namedChildren ?? node.children ?? []) {
				visit(child, depth + 1);
			}

			return;
		}

		const rule = ruleForNodeType(node.type);
		if (rule && typeof node.startIndex === 'number') {
			const tooDeep = rule.maxDepth !== undefined && depth > rule.maxDepth;
			if (!tooDeep && rule.type !== 'lexical_declaration') {
				const name = extractNodeName(node, source, rule);
				const anonymous = !name || name === node.type || name === rule.kind;
				if (!(rule.skipAnonymous && anonymous) && !(rule.requireName && anonymous) && name) {
					pushSpan(raw, node, name, rule.kind);
				}
			}
		}

		for (const child of node.namedChildren ?? node.children ?? []) {
			visit(child, depth + 1);
		}
	};

	visit(root, 0);

	// Убрать function, строго вложенные в другой function/method (arrow внутри метода и т.п.)
	const sorted = [...raw].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
	const picked: CollectedSpan[] = [];
	for (const s of sorted) {
		const dup = picked.some((p) => p.kind === s.kind && p.name === s.name && p.startLine === s.startLine && p.endLine === s.endLine);
		if (dup) {
			continue;
		}

		if (s.kind === 'function') {
			const insideFnOrMethod = picked.some((p) => (p.kind === 'function' || p.kind === 'method') && s.startIndex >= p.startIndex && s.endIndex <= p.endIndex && !(s.startIndex === p.startIndex && s.endIndex === p.endIndex));
			if (insideFnOrMethod) {
				continue;
			}
		}

		picked.push(s);
	}

	return picked;
}
