import * as assert from 'node:assert';
import { buildMerkleDocument, chunkContentDigest, detectMerkleIssues, mergeChunksPreservingDigests, parseMerkleJson, patchMerkleDocument, repairMerkleFromManifest, unchangedSymbolLeaves, MERKLE_ALGORITHM, MERKLE_VERSION } from '../features/index/merkle.js';
import { emptyManifest } from '../features/index/types.js';
import type { IndexChunk } from '../features/index/types.js';
import { chunkFileContentAst, contentChunkId } from '../features/index/chunk.js';
import { contentHash } from '../features/index/hash.js';
import { canSkipDirRewalk } from '../features/index/dirDigests.js';

suite('merkle v2', () => {
	test('digest каталога стабилен при перестановке детей', () => {
		const a = buildMerkleDocument({
			'src/b.ts': { hash: 'hb' },
			'src/a.ts': { hash: 'ha' },
			'README.md': { hash: 'hr' },
		});
		const b = buildMerkleDocument({
			'README.md': { hash: 'hr' },
			'src/a.ts': { hash: 'ha' },
			'src/b.ts': { hash: 'hb' },
		});
		assert.strictEqual(a.nodes['']?.digest, b.nodes['']?.digest);
		assert.strictEqual(a.nodes['src']?.digest, b.nodes['src']?.digest);
		assert.strictEqual(a.algorithm, MERKLE_ALGORITHM);
		assert.strictEqual(a.version, MERKLE_VERSION);
	});

	test('смена digest файла помечает только предков', () => {
		const before = buildMerkleDocument({
			'src/a.ts': { hash: 'ha' },
			'src/b.ts': { hash: 'hb' },
		});
		const after = buildMerkleDocument({
			'src/a.ts': { hash: 'ha-changed' },
			'src/b.ts': { hash: 'hb' },
		});
		assert.notStrictEqual(before.nodes['src/a.ts']?.digest, after.nodes['src/a.ts']?.digest);
		assert.strictEqual(before.nodes['src/b.ts']?.digest, after.nodes['src/b.ts']?.digest);
		assert.notStrictEqual(before.nodes['src']?.digest, after.nodes['src']?.digest);
	});

	test('mergeChunksPreservingDigests переиспользует неизменённое тело функции', () => {
		const prev: Record<string, IndexChunk> = {
			'f.ts#c1': {
				id: 'f.ts#c1',
				path: 'f.ts',
				startLine: 1,
				endLine: 3,
				text: 'function a() {\n  return 1;\n}',
			},
			'f.ts#c2': {
				id: 'f.ts#c2',
				path: 'f.ts',
				startLine: 5,
				endLine: 7,
				text: 'function b() {\n  return 2;\n}',
			},
		};
		const prevDigests = {
			'f.ts#c1': chunkContentDigest(prev['f.ts#c1']!.text),
			'f.ts#c2': chunkContentDigest(prev['f.ts#c2']!.text),
		};
		const next: IndexChunk[] = [
			{
				id: 'f.ts#new1',
				path: 'f.ts',
				startLine: 1,
				endLine: 3,
				text: 'function a() {\n  return 1;\n}',
			},
			{
				id: 'f.ts#new2',
				path: 'f.ts',
				startLine: 5,
				endLine: 8,
				text: 'function b() {\n  return 3;\n}',
			},
		];
		const merged = mergeChunksPreservingDigests(prev, prevDigests, next);
		assert.ok(merged.skippedIds.includes('f.ts#c1'));
		assert.ok(merged.indexedIds.length >= 1);
		assert.strictEqual(merged.chunks['f.ts#c1']?.text.includes('return 1'), true);
	});

	test('detectMerkleIssues находит mismatch', () => {
		const manifest = emptyManifest();
		manifest.files['a.ts'] = { hash: 'h1', size: 1, chunkIds: [] };
		const merkle = buildMerkleDocument({ 'a.ts': { hash: 'other' } });
		const issues = detectMerkleIssues(manifest, merkle);
		assert.ok(issues.mismatches.includes('a.ts'));
	});

	test('repairMerkleFromManifest пересобирает узлы', () => {
		const manifest = emptyManifest();
		manifest.files['src/x.ts'] = { hash: 'hx', size: 2, chunkIds: ['c1'] };
		manifest.chunks['c1'] = {
			id: 'c1',
			path: 'src/x.ts',
			startLine: 1,
			endLine: 1,
			text: 'export const x = 1;',
		};
		const doc = repairMerkleFromManifest(manifest);
		assert.ok(doc.nodes['src/x.ts']);
		assert.ok(doc.chunkDigests['c1']);
		assert.ok(doc.nodes['']?.kind === 'dir');
	});

	test('parseMerkleJson отклоняет неверную version', () => {
		assert.strictEqual(parseMerkleJson('{"version":99}'), undefined);
		const ok = parseMerkleJson(
			JSON.stringify({
				version: MERKLE_VERSION,
				algorithm: MERKLE_ALGORITHM,
				updatedAt: new Date().toISOString(),
				nodes: {},
				chunkDigests: {},
				symbolDigests: {},
			}),
		);
		assert.ok(ok);
	});

	test('chunkFileContentAst даёт id, стабильные по содержимому', () => {
		const src = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
		const spans = [
			{ name: 'a', kind: 'function', startLine: 1, endLine: 3, startIndex: 0, endIndex: 28 },
			{ name: 'b', kind: 'function', startLine: 5, endLine: 7, startIndex: 30, endIndex: 58 },
		];
		const chunks = chunkFileContentAst('f.ts', src, spans);
		assert.ok(chunks.length >= 2);
		assert.ok(chunks.every((c) => c.id.includes('#c')));
	});

	test('contentChunkId совпадает с contentHash (sha256 prefix)', () => {
		const text = 'function a() { return 1; }';
		const id = contentChunkId('f.ts', text);
		assert.strictEqual(id, `f.ts#c${contentHash(text).slice(0, 16)}`);
		assert.strictEqual(chunkContentDigest(text), contentHash(text));
	});

	test('patchMerkleDocument мержит digests и чистит удалённые пути', () => {
		const prev = buildMerkleDocument(
			{ 'a.ts': { hash: 'ha' }, 'b.ts': { hash: 'hb' } },
			{ chunkDigests: { 'a.ts#c1': 'd1', 'b.ts#c1': 'd2' }, symbolDigests: { 'a.ts#1-2:x': 's1' } },
		);
		const next = patchMerkleDocument(prev, { 'a.ts': { hash: 'ha2' } }, {
			chunkDigests: { 'a.ts#c2': 'd3' },
			symbolDigests: { 'a.ts#1-2:x': 's1' },
		});
		assert.ok(next.nodes['a.ts']);
		assert.strictEqual(next.nodes['b.ts'], undefined);
		assert.ok(next.chunkDigests['a.ts#c2']);
		assert.strictEqual(next.chunkDigests['b.ts#c1'], undefined);
	});

	test('unchangedSymbolLeaves', () => {
		const leaves = unchangedSymbolLeaves(
			{ 'a.ts#1-2:f': 'h1', 'a.ts#3-4:g': 'h2' },
			{ 'a.ts#1-2:f': 'h1', 'a.ts#3-4:g': 'h3' },
		);
		assert.deepStrictEqual(leaves, ['a.ts#1-2:f']);
	});

	test('forceContentHash блокирует skip без явного hash', () => {
		const manifest = emptyManifest();
		manifest.files['a.ts'] = { hash: 'h', size: 10, mtimeMs: 1, chunkIds: [] };
		manifest.dirDigests = { '': 'root' };
		assert.strictEqual(
			canSkipDirRewalk(manifest, '', [{ relative: 'a.ts', size: 10, mtimeMs: 1 }]),
			true,
		);
		assert.strictEqual(
			canSkipDirRewalk(manifest, '', [{ relative: 'a.ts', size: 10, mtimeMs: 1 }], {
				forceContentHash: true,
			}),
			false,
		);
		assert.strictEqual(
			canSkipDirRewalk(manifest, '', [{ relative: 'a.ts', size: 10, contentHash: 'h' }], {
				forceContentHash: true,
			}),
			true,
		);
	});
});
