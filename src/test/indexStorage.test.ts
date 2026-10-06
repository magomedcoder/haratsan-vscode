import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { folderStorageKey, indexDirForFolder, indexFilePath, INDEX_MANIFEST_FILE, initIndexStorage, isIndexStorageAvailable, mapDirForFolder, setIndexStorageRootForTests } from '../features/index/indexStorage.js';
import { loadManifest, saveManifest } from '../features/index/store.js';
import { emptyManifest } from '../features/index/types.js';

suite('indexStorage', () => {
	let tmp: string;

	suiteSetup(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haratsan-index-storage-'));
	});

	suiteTeardown(async () => {
		setIndexStorageRootForTests(undefined);
		await fs.rm(tmp, { recursive: true, force: true });
	});

	test('folderStorageKey стабилен и короткий', () => {
		const a = folderStorageKey('/home/me/proj');
		const b = folderStorageKey('/home/me/proj');
		assert.strictEqual(a, b);
		assert.strictEqual(a.length, 16);
		assert.notStrictEqual(a, folderStorageKey('/home/me/other'));
	});

	test('без storageUri пути undefined', () => {
		setIndexStorageRootForTests(undefined);
		assert.strictEqual(isIndexStorageAvailable(), false);
		assert.strictEqual(indexDirForFolder('/ws'), undefined);
		assert.strictEqual(mapDirForFolder('/ws'), undefined);
	});

	test('пути под storageUri/index|map/<key>', () => {
		setIndexStorageRootForTests(tmp);
		assert.strictEqual(isIndexStorageAvailable(), true);
		const folder = '/workspace/demo';
		const key = folderStorageKey(folder);
		assert.strictEqual(indexDirForFolder(folder), path.join(tmp, 'index', key));
		assert.strictEqual(mapDirForFolder(folder), path.join(tmp, 'map', key));
		assert.strictEqual(
			indexFilePath(folder, INDEX_MANIFEST_FILE),
			path.join(tmp, 'index', key, 'manifest.json'),
		);
	});

	test('saveManifest / loadManifest пишут вне проекта', async () => {
		setIndexStorageRootForTests(tmp);
		const folder = path.join(tmp, 'fake-workspace');
		await fs.mkdir(folder, { recursive: true });

		const manifest = emptyManifest();
		manifest.files['a.ts'] = {
			hash: 'abc',
			size: 1,
			chunkIds: [],
		};
		await saveManifest(folder, manifest);

		const loaded = await loadManifest(folder);
		assert.ok(loaded.files['a.ts']);
		assert.strictEqual(loaded.files['a.ts']!.hash, 'abc');
	});

	test('initIndexStorage читает context.storageUri', () => {
		setIndexStorageRootForTests(undefined);
		initIndexStorage({
			storageUri: { fsPath: tmp },
		} as Parameters<typeof initIndexStorage>[0]);
		assert.strictEqual(isIndexStorageAvailable(), true);
		assert.ok(indexDirForFolder('/x')?.startsWith(tmp));
	});
});
