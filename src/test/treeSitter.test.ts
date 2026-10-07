import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initTreeSitterFromPath, isTreeSitterAvailable, parseWithTreeSitter } from '../features/index/treeSitter.js';
import { outlineEntriesFromTreeSitterSpans } from '../features/index/treeSitterOutline.js';
import { parseTsOutline } from '../features/index/tsOutlineParse.js';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(EXT_ROOT, 'src', 'test', 'fixtures', 'treesitter');

function readFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

suite('tree-sitter wasm fixtures', () => {
	suiteSetup(() => {
		initTreeSitterFromPath(EXT_ROOT);
		assert.ok(isTreeSitterAvailable(), 'корень wasm должен находиться (dist/tree-sitter или node_modules)');
	});

	test('typescript: class / method / function / type', async () => {
		const src = readFixture('sample.ts');
		const parsed = await parseWithTreeSitter('sample.ts', src);
		assert.ok(parsed);
		assert.strictEqual(parsed!.source, 'treesitter');
		const names = new Set(parsed!.spans.map((s) => s.name));
		assert.ok(names.has('Widget'));
		assert.ok(names.has('createWidget') || names.has('render'));
		const outline = outlineEntriesFromTreeSitterSpans('sample.ts', parsed!.spans);
		assert.ok(outline.every((e) => e.source === 'treesitter'));
		assert.ok(outline.some((e) => e.name === 'Widget' && e.kind === 'class'));
	});

	test('typescript: parity outline vs createSourceFile (золотые имена)', async () => {
		const src = readFixture('sample.ts');
		const parsed = await parseWithTreeSitter('sample.ts', src);
		assert.ok(parsed);
		const tsNames = new Set(parseTsOutline('sample.ts', src).map((e) => e.name));
		const treeNames = new Set(outlineEntriesFromTreeSitterSpans('sample.ts', parsed!.spans).map((e) => e.name));
		for (const must of ['Widget', 'createWidget', 'render']) {
			assert.ok(tsNames.has(must), `TS API: нет ${must}`);
			assert.ok(treeNames.has(must), `Tree-sitter: нет ${must}`);
		}
	});

	test('python: class / methods / function', async () => {
		const src = readFixture('sample.py');
		const parsed = await parseWithTreeSitter('sample.py', src);
		assert.ok(parsed);
		const names = new Set(parsed!.spans.map((s) => s.name));
		assert.ok(names.has('Greeter'));
		assert.ok(names.has('hello') || names.has('main'));
	});

	test('go: function / type / method', async () => {
		const src = readFixture('sample.go');
		const parsed = await parseWithTreeSitter('sample.go', src);
		assert.ok(parsed);
		const names = new Set(parsed!.spans.map((s) => s.name));
		assert.ok(names.has('NewServer') || names.has('Server') || names.has('Listen'));
	});

	test('rust: struct / impl methods / function', async () => {
		const src = readFixture('sample.rs');
		const parsed = await parseWithTreeSitter('sample.rs', src);
		assert.ok(parsed);
		const names = new Set(parsed!.spans.map((s) => s.name));
		assert.ok(names.has('Counter') || names.has('make_counter') || names.has('new'));
	});

	test('java: class / methods', async () => {
		const src = readFixture('sample.java');
		const parsed = await parseWithTreeSitter('sample.java', src);
		assert.ok(parsed);
		const names = new Set(parsed!.spans.map((s) => s.name));
		assert.ok(names.has('App'));
		assert.ok(names.has('main') || names.has('greet'));
	});

	test('слишком большой файл - soft-fail', async () => {
		const huge = 'x'.repeat(500_001);
		const parsed = await parseWithTreeSitter('huge.ts', `export const x = "${huge}";`);
		assert.strictEqual(parsed, undefined);
	});
});
