/**
 * Записи outline из Tree-sitter spans -> общая схема OutlineEntry.
 */

import type { OutlineEntry, OutlineKind } from './tsOutlineParse';
import { parseWithTreeSitter, type TreeSitterSpan } from './treeSitter';

const KIND_MAP: Record<string, OutlineKind> = {
	function: 'function',
	method: 'method',
	class: 'class',
	interface: 'interface',
	type: 'type',
	enum: 'enum',
	variable: 'variable',
	namespace: 'namespace',
	module: 'module',
	field: 'field',
	property: 'property',
	macro: 'macro',
};

export function outlineEntriesFromTreeSitterSpans(
	relativePath: string,
	spans: TreeSitterSpan[],
): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	for (const s of spans) {
		const kind = KIND_MAP[s.kind];
		if (!kind) {
			continue;
		}
		if (!s.name || s.name === s.kind || s.name.length > 200) {
			continue;
		}
		out.push({
			name: s.name,
			kind,
			path: relativePath,
			startLine: s.startLine,
			endLine: s.endLine,
			source: 'treesitter',
		});
	}
	return out;
}

export async function extractOutlineViaTreeSitter(
	relativePath: string,
	sourceText: string,
): Promise<OutlineEntry[] | undefined> {
	const parsed = await parseWithTreeSitter(relativePath, sourceText);
	if (!parsed || parsed.spans.length === 0) {
		return undefined;
	}
	return outlineEntriesFromTreeSitterSpans(relativePath, parsed.spans);
}
