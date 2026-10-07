import * as assert from 'node:assert';
import {
	parseTsOutline,
	parseRegexOutlineFallback,
	isJsLikeOutlinePath,
	isRegexOutlineFallbackPath,
	mapLspSymbolKindToOutlineKind,
	flattenLspDocumentSymbolsToOutline,
	flattenLspSymbolInfosToOutline,
	outlineEntriesFromLspProviderResult,
	preferLspOrRegexOutline,
	scoreOutlineQuery,
	searchOutlineEntries,
	summarizeOutlineForPath,
	applyOutlinePathUpdate,
	applyOutlinePathRemove,
	type OutlineDocument,
} from '../features/index/tsOutlineParse.js';

suite('tsOutlineParse', () => {
	test('isJsLikeOutlinePath', () => {
		assert.strictEqual(isJsLikeOutlinePath('src/a.ts'), true);
		assert.strictEqual(isJsLikeOutlinePath('x.tsx'), true);
		assert.strictEqual(isJsLikeOutlinePath('a.py'), false);
	});

	test('isRegexOutlineFallbackPath', () => {
		assert.strictEqual(isRegexOutlineFallbackPath('a.py'), true);
		assert.strictEqual(isRegexOutlineFallbackPath('main.go'), true);
		assert.strictEqual(isRegexOutlineFallbackPath('a.ts'), false);
	});

	test('mapLspSymbolKindToOutlineKind', () => {
		assert.strictEqual(mapLspSymbolKindToOutlineKind(4), 'class'); // Class
		assert.strictEqual(mapLspSymbolKindToOutlineKind(22), 'class'); // Struct
		assert.strictEqual(mapLspSymbolKindToOutlineKind(10), 'interface');
		assert.strictEqual(mapLspSymbolKindToOutlineKind(9), 'enum');
		assert.strictEqual(mapLspSymbolKindToOutlineKind(11), 'function');
		assert.strictEqual(mapLspSymbolKindToOutlineKind(5), 'method');
		assert.strictEqual(mapLspSymbolKindToOutlineKind(8), 'method'); // Constructor
		assert.strictEqual(mapLspSymbolKindToOutlineKind(12), 'variable');
		assert.strictEqual(mapLspSymbolKindToOutlineKind(13), 'variable'); // Constant
		assert.strictEqual(mapLspSymbolKindToOutlineKind(25), 'type'); // TypeParameter
		assert.strictEqual(mapLspSymbolKindToOutlineKind(1), 'module'); // Module
		assert.strictEqual(mapLspSymbolKindToOutlineKind(2), 'namespace'); // Namespace
		assert.strictEqual(mapLspSymbolKindToOutlineKind(6), 'property'); // Property
		assert.strictEqual(mapLspSymbolKindToOutlineKind(7), 'field'); // Field
		assert.strictEqual(mapLspSymbolKindToOutlineKind(0), undefined); // File
		assert.strictEqual(mapLspSymbolKindToOutlineKind(14), undefined); // String
	});

	test('flattenLspDocumentSymbolsToOutline walks children + 1-based lines', () => {
		const entries = flattenLspDocumentSymbolsToOutline(
			[
				{
					name: 'Widget',
					kind: 4,
					range: {
						start: {
							line: 0
						},
						end: {
							line: 10
						}
					},
					children: [
						{
							name: 'render',
							kind: 5,
							range: {
								start: {
									line: 2
								},
								end: {
									line: 4
								}
							},
						},
					],
				},
			],
			'src/a.py',
		);
		assert.strictEqual(entries.length, 2);
		assert.deepStrictEqual(
			entries.map((e) => `${e.kind}:${e.name}:${e.startLine}:${e.containerName ?? ''}`),
			['class:Widget:1:', 'method:render:3:Widget'],
		);
	});

	test('flattenLspSymbolInfosToOutline', () => {
		const entries = flattenLspSymbolInfosToOutline(
			[
				{
					name: 'helper',
					kind: 11,
					location: {
						range: {
							start: {
								line: 4
							},
							end: {
								line: 6
							}
						}
					},
					containerName: 'mod',
				},
			],
			'main.go',
		);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]?.kind, 'function');
		assert.strictEqual(entries[0]?.startLine, 5);
		assert.strictEqual(entries[0]?.containerName, 'mod');
	});

	test('outlineEntriesFromLspProviderResult detects DocumentSymbol vs SymbolInformation', () => {
		const fromDoc = outlineEntriesFromLspProviderResult([
			{
				name: 'A',
				kind: 4,
				range: {
					start: {
						line: 0
					},
					end: {
						line: 1
					}
				},
				children: []
			}
		], 'a.py');
		assert.strictEqual(fromDoc[0]?.kind, 'class');

		const fromInfo = outlineEntriesFromLspProviderResult(
			[
				{
					name: 'B',
					kind: 11,
					location: { 
						range: { 
							start: { 
								line: 1
							},
							end: {
								line: 2
							}
						}
					},
				},
			],
			'b.go',
		);
		assert.strictEqual(fromInfo[0]?.kind, 'function');
		assert.deepStrictEqual(outlineEntriesFromLspProviderResult([], 'x.py'), []);
		assert.deepStrictEqual(outlineEntriesFromLspProviderResult(undefined, 'x.py'), []);
	});

	test('preferLspOrRegexOutline - LSP wins; regex when LSP empty', () => {
		const lsp = [
			{
				name: 'FromLsp',
				kind: 'function' as const,
				path: 'a.py',
				startLine: 1,
				endLine: 2
			},
		];
		const regex = [
			{
				name: 'FromRegex',
				kind: 'function' as const,
				path: 'a.py',
				startLine: 1,
				endLine: 1
			},
		];
		assert.strictEqual(preferLspOrRegexOutline(lsp, regex)[0]?.name, 'FromLsp');
		assert.strictEqual(preferLspOrRegexOutline([], regex)[0]?.name, 'FromRegex');
		assert.deepStrictEqual(preferLspOrRegexOutline([], []), []);
	});


	test('extracts imports, class, function from TS', () => {
		const src = `
import { foo } from './foo';
import Bar from './bar';

export class Widget {
  render() {
    return 1;
  }
}

export function helper(x: number) {
  return x;
}

export const arrow = () => 42;
`;
		const entries = parseTsOutline('src/widget.ts', src);
		const kinds = entries.map((e) => `${e.kind}:${e.name}`);
		assert.ok(kinds.includes('import:foo'), kinds.join(','));
		assert.ok(kinds.includes('import:Bar'), kinds.join(','));
		assert.ok(kinds.includes('class:Widget'), kinds.join(','));
		assert.ok(kinds.includes('method:render'), kinds.join(','));
		assert.ok(kinds.includes('function:helper'), kinds.join(','));
		assert.ok(kinds.includes('function:arrow'), kinds.join(','));
		const widget = entries.find((e) => e.name === 'Widget');
		assert.ok(widget);
		assert.ok(widget!.startLine >= 1);
	});

	test('regex fallback for python-ish', () => {
		const src = 'def hello():\n  pass\nclass Foo:\n  pass\n';
		const entries = parseRegexOutlineFallback('a.py', src);
		assert.ok(entries.some((e) => e.name === 'hello' && e.kind === 'function'));
		assert.ok(entries.some((e) => e.name === 'Foo' && e.kind === 'class'));
	});

	test('searchOutlineEntries ranks exact match first', () => {
		const entries = [
			{ 
				name: 'Widget', 
				kind: 'class' as const, 
				path: 'a.ts', 
				startLine: 1, 
				endLine: 2 
			},
			{ 
				name: 'WidgetHelper', 
				kind: 'function' as const, 
				path: 'b.ts', 
				startLine: 1, 
				endLine: 2 
			},
		];
		const hits = searchOutlineEntries('Widget', entries, 5);
		assert.strictEqual(hits[0]?.name, 'Widget');
		assert.ok(scoreOutlineQuery('Widget', hits[0]!) >= scoreOutlineQuery('Widget', hits[1]!));
	});

	test('summarizeOutlineForPath lists exports', () => {
		const src = `
export class Widget {}
export function helper() {}
import { x } from './x';
`;
		const entries = parseTsOutline('src/widget.ts', src);
		const summary = summarizeOutlineForPath(entries, 'src/widget.ts');
		assert.ok(summary?.includes('Widget'), summary);
		assert.ok(summary?.includes('helper'), summary);
		assert.ok(!summary?.includes('import'), summary);
	});

	test('applyOutlinePathUpdate / remove - per-file без полного rebuild', () => {
		const base: OutlineDocument = {
			updatedAt: '',
			fileCount: 2,
			entries: [
				{
					name: 'A',
					kind: 'class',
					path: 'a.ts',
					startLine: 1,
					endLine: 2
				},
				{
					name: 'B',
					kind: 'function',
					path: 'b.ts',
					startLine: 1,
					endLine: 2
				},
			],
		};
		const updated = applyOutlinePathUpdate(base, 'a.ts', [
			{
				name: 'A2',
				kind: 'class',
				path: 'a.ts',
				startLine: 1,
				endLine: 5
			}
		], 12_000);
		assert.strictEqual(updated.entries.filter((e) => e.path === 'a.ts').length, 1);
		assert.strictEqual(updated.entries.find((e) => e.path === 'a.ts')?.name, 'A2');
		assert.ok(updated.entries.some((e) => e.path === 'b.ts'));
		assert.strictEqual(updated.fileCount, 2);

		const removed = applyOutlinePathRemove(updated, 'b.ts');
		assert.ok(!removed.entries.some((e) => e.path === 'b.ts'));
		assert.strictEqual(removed.fileCount, 1);
	});
});
