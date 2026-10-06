import * as assert from 'node:assert';
import { LOCAL_HASH_DIMS, LOCAL_HASH_MODEL_ID, localHashEmbed, l2Normalize } from './localHashEmbed.js';
import { cosineSimilarity, emptyVectorIndex, searchVectorIndex, syncLocalHashVectors, upsertRemoteVectors, vectorEntryKey } from './vectorStore.js';
import type { IndexManifest } from './types.js';
import { chunkFileContent } from './chunk.js';
import { buildTrigramIndex } from './trigram.js';

suite('localHashEmbed / vectorStore', () => {
	test('localHashEmbed: фиксированная размерность и L2≈1', () => {
		const v = localHashEmbed('authenticateUser token verify', LOCAL_HASH_DIMS);
		assert.strictEqual(v.length, LOCAL_HASH_DIMS);
		const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
		assert.ok(Math.abs(norm - 1) < 1e-6, `norm=${norm}`);
	});

	test('localHashEmbed: похожие тексты ближе, чем разные', () => {
		const a = localHashEmbed('authenticateUser verifyToken login session');
		const b = localHashEmbed('authenticate user verify token login');
		const c = localHashEmbed('renderButton label html css stylesheet');
		const simAb = cosineSimilarity(a, b);
		const simAc = cosineSimilarity(a, c);
		assert.ok(simAb > 0.2, `sim(auth)=${simAb} ожидается > 0.2`);
		assert.ok(simAb > simAc, `sim(auth)=${simAb} should > sim(ui)=${simAc}`);
	});

	test('l2Normalize нулевого вектора', () => {
		const z = l2Normalize([0, 0, 0]);
		assert.deepStrictEqual(z, [0, 0, 0]);
	});

	test('syncLocalHashVectors + searchVectorIndex находит релевантный path', () => {
		const files = [
			{
				path: 'src/auth/login.ts',
				content: 'export function authenticateUser(token: string) { return verifyToken(token); }\n',
			},
			{
				path: 'src/ui/button.ts',
				content: 'export function renderButton(label: string) { return `<button>${label}</button>`; }\n',
			},
		];
		const chunks = files.flatMap((f) => chunkFileContent(f.path, f.content));
		const byId = Object.fromEntries(chunks.map((c) => [c.id, c]));
		const manifest: IndexManifest = {
			version: 1,
			updatedAt: '2026-10-07T00:00:00.000Z',
			files: Object.fromEntries(
				files.map((f) => [
					f.path,
					{ 
						hash: `h-${f.path}`, 
						size: f.content.length, 
						chunkIds: chunks.filter((c) => c.path === f.path).map((c) => c.id) 
					},
				]),
			),
			chunks: byId,
			trigrams: buildTrigramIndex(chunks),
			dirDigests: {},
		};
		const index = syncLocalHashVectors(manifest, emptyVectorIndex());
		const localCount = Object.values(index.entries).filter((e) => e.source === 'local-hash').length;
		assert.ok(localCount >= 2);
		const q = localHashEmbed('authenticate user token verify');
		const hits = searchVectorIndex(index, q, {
			maxResults: 3,
			model: LOCAL_HASH_MODEL_ID,
			source: 'local-hash',
		});
		assert.ok(hits.length > 0);
		assert.strictEqual(hits[0]!.path, 'src/auth/login.ts');
	});

	test('upsertRemoteVectors сохраняет model/key', () => {
		const chunk = {
			id: 'c1',
			path: 'a.ts',
			startLine: 1,
			endLine: 2,
			text: 'hello world',
		};
		const index = upsertRemoteVectors(emptyVectorIndex(), [
			{
				chunk,
				contentHash: 'abc',
				model: 'text-embedding-3-small',
				vector: l2Normalize([1, 0, 0, 0]),
			},
		]);
		const key = vectorEntryKey('abc', 'text-embedding-3-small', 'c1');
		assert.ok(index.entries[key]);
		assert.strictEqual(index.entries[key]!.source, 'remote');
	});
});
