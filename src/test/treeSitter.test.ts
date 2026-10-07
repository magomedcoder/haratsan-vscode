import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTreeSitterMetrics, initTreeSitterFromPath, isTreeSitterAvailable, parseWithTreeSitter, resetTreeSitterMetricsForTests, setTreeSitterLanguageAllowlist } from '../features/index/treeSitter.js';
import { outlineEntriesFromTreeSitterSpans } from '../features/index/treeSitterOutline.js';
import { parseTsOutline } from '../features/index/tsOutlineParse.js';

const EXT_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(EXT_ROOT, 'src', 'test', 'fixtures', 'treesitter');

function readFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

async function assertHasAnyName(file: string, candidates: string[]): Promise<void> {
	const src = readFixture(file);
	const parsed = await parseWithTreeSitter(file, src);
	assert.ok(parsed, `parse ${file}`);
	const names = new Set(parsed!.spans.map((s) => s.name));
	assert.ok(candidates.some((c) => names.has(c)), `${file}: ожидали одно из [${candidates.join(', ')}], получили [${[...names].slice(0, 20).join(', ')}]`);
}

suite('tree-sitter wasm fixtures', () => {
	suiteSetup(() => {
		initTreeSitterFromPath(EXT_ROOT);
		assert.ok(isTreeSitterAvailable(), 'корень wasm должен находиться (dist/tree-sitter или node_modules)');
		setTreeSitterLanguageAllowlist(['*']);
		resetTreeSitterMetricsForTests();
	});

	suiteTeardown(() => {
		setTreeSitterLanguageAllowlist(undefined);
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
		const treeNames = new Set(
			outlineEntriesFromTreeSitterSpans('sample.ts', parsed!.spans).map((e) => e.name),
		);
		for (const must of ['Widget', 'createWidget', 'render']) {
			assert.ok(tsNames.has(must), `TS API: нет ${must}`);
			assert.ok(treeNames.has(must), `Tree-sitter: нет ${must}`);
		}
	});

	test('не эмитит export_statement как variable', async () => {
		const src = 'export const answer = 42;\nexport function foo() { return 1; }\n';
		const parsed = await parseWithTreeSitter('n.ts', src);
		assert.ok(parsed);
		assert.ok(!parsed!.spans.some((s) => s.name === 'export_statement'));
		assert.ok(parsed!.spans.some((s) => s.name === 'foo' && s.kind === 'function'));
	});

	test('фильтр вложенных arrow внутри function', async () => {
		const src = 'function outer() {\n  const inner = () => 1;\n  return inner();\n}\n';
		const parsed = await parseWithTreeSitter('nest.ts', src);
		assert.ok(parsed);
		const fns = parsed!.spans.filter((s) => s.kind === 'function');
		assert.ok(fns.some((s) => s.name === 'outer'));
		assert.ok(!fns.some((s) => s.name === 'inner'));
	});

	test('python / go / rust / java', async () => {
		await assertHasAnyName('sample.py', ['Greeter', 'hello', 'main']);
		await assertHasAnyName('sample.go', ['NewServer', 'Server', 'Listen']);
		await assertHasAnyName('sample.rs', ['Counter', 'make_counter', 'new']);
		await assertHasAnyName('sample.java', ['App', 'main', 'greet']);
	});

	test('tsx / javascript / cpp / c# / ruby / php / bash', async () => {
		await assertHasAnyName('sample.tsx', ['App', 'label']);
		await assertHasAnyName('sample.js', ['greet', 'Person', 'hello']);
		await assertHasAnyName('sample.cpp', ['Widget', 'main', 'demo', 'render']);
		await assertHasAnyName('sample.cs', ['Widget', 'Render', 'Program', 'Main', 'Demo']);
		await assertHasAnyName('sample.rb', ['Greeter', 'hello', 'main']);
		await assertHasAnyName('sample.php', ['Greeter', 'hello', 'main']);
		await assertHasAnyName('sample.sh', ['greet', 'main']);
	});

	test('css opt-in (wasm в пакете)', async () => {
		const src = readFixture('sample.css');
		const parsed = await parseWithTreeSitter('sample.css', src);
		// css grammar может дать мало именованных span - достаточно успешного parse
		assert.ok(parsed);
		assert.strictEqual(parsed!.lang, 'css');
	});

	test('кэш spans: повторный parse того же файла', async () => {
		resetTreeSitterMetricsForTests();
		const src = readFixture('sample.ts');
		await parseWithTreeSitter('cache.ts', src);
		const before = getTreeSitterMetrics().cacheHit;
		await parseWithTreeSitter('cache.ts', src);
		assert.ok(getTreeSitterMetrics().cacheHit > before);
	});

	test('слишком большой файл - oversized + метрика', async () => {
		resetTreeSitterMetricsForTests();
		const huge = 'x'.repeat(500_001);
		const parsed = await parseWithTreeSitter('huge.ts', `export const x = "${huge}";`);
		assert.strictEqual(parsed, undefined);
		assert.ok(getTreeSitterMetrics().oversized >= 1);
	});

	test('MVP allowlist отключает css', async () => {
		setTreeSitterLanguageAllowlist([]);
		const parsed = await parseWithTreeSitter('sample.css', readFixture('sample.css'));
		assert.strictEqual(parsed, undefined);
		setTreeSitterLanguageAllowlist(['*']);
	});
});
