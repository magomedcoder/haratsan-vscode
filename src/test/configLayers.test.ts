import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deepMerge, parseFileConfig, pickNonDefaultSettings } from '../core/config/layers.js';
import { applyAdminPolicy, matchAdminPattern, parseAdminPolicy, reloadAdminPolicy, resetAdminPolicyForTests, resolveAdminPolicyCandidates } from '../core/config/adminPolicy.js';
import { DEFAULT_SETTINGS } from '../core/config/types.js';
import { getHaratsanUserConfigDir, getHaratsanUserConfigPath } from '../core/config/userPaths.js';

suite('config layers', () => {
	test('deepMerge: объекты рекурсивно, массивы заменой', () => {
		const merged = deepMerge(
			{ a: 1, nested: { x: 1, y: 2 }, list: [1] },
			{ nested: { y: 9, z: 3 }, list: [2, 3], b: true },
		);
		assert.deepStrictEqual(merged, {
			a: 1,
			b: true,
			nested: { x: 1, y: 9, z: 3 },
			list: [2, 3],
		});
	});

	test('deepMerge: undefined в source не затирает', () => {
		const merged = deepMerge({ a: 1, b: 2 }, { a: undefined, b: 3 });
		assert.deepStrictEqual(merged, { a: 1, b: 3 });
	});

	test('parseFileConfig: только известные ключи + hooks', () => {
		const parsed = parseFileConfig({
			version: 1,
			createdAt: '2026-01-01',
			systemPrompt: 'hello',
			webSearchEnabled: false,
			unknownKey: 42,
			hooksPath: '.haratsan/custom-hooks.json',
			hooks: { beforeSubmit: ['echo'] },
		});
		assert.strictEqual(parsed.settings.systemPrompt, 'hello');
		assert.strictEqual(parsed.settings.webSearchEnabled, false);
		assert.strictEqual((parsed.settings as { unknownKey?: unknown }).unknownKey, undefined);
		assert.strictEqual(parsed.hooksPath, '.haratsan/custom-hooks.json');
		assert.deepStrictEqual(parsed.hooks, { beforeSubmit: ['echo'] });
		assert.strictEqual('version' in parsed.settings, false);
	});

	test('pickNonDefaultSettings: только отличия от defaults', () => {
		const overlay = pickNonDefaultSettings({
			...DEFAULT_SETTINGS,
			systemPrompt: 'custom',
			temperature: DEFAULT_SETTINGS.temperature,
		});
		assert.strictEqual(overlay.systemPrompt, 'custom');
		assert.strictEqual(overlay.temperature, undefined);
	});

	test('getHaratsanUserConfigPath уважает HARATSAN_CONFIG_DIR и XDG', () => {
		const prevHaratsan = process.env.HARATSAN_CONFIG_DIR;
		const prevXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.HARATSAN_CONFIG_DIR = path.join(os.tmpdir(), 'haratsan-cfg-test');
			assert.strictEqual(getHaratsanUserConfigDir(), path.resolve(process.env.HARATSAN_CONFIG_DIR));
			assert.strictEqual(
				getHaratsanUserConfigPath(),
				path.join(path.resolve(process.env.HARATSAN_CONFIG_DIR), 'config.json'),
			);

			delete process.env.HARATSAN_CONFIG_DIR;
			if (process.platform === 'linux') {
				process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), 'xdg-cfg');
				assert.ok(getHaratsanUserConfigDir().endsWith(`${path.sep}haratsan`) || getHaratsanUserConfigDir().endsWith('/haratsan'));
			}
		} finally {
			if (prevHaratsan === undefined) {
				delete process.env.HARATSAN_CONFIG_DIR;
			} else {
				process.env.HARATSAN_CONFIG_DIR = prevHaratsan;
			}
			if (prevXdg === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = prevXdg;
			}
		}
	});

	test('parseFileConfig: пустой / битый вход', () => {
		assert.deepStrictEqual(parseFileConfig(null).settings, {});
		assert.deepStrictEqual(parseFileConfig('x').settings, {});
		assert.deepStrictEqual(parseFileConfig([]).settings, {});
	});

	test('user config path - существующий каталог tmp можно записать', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-user-cfg-'));
		const file = path.join(dir, 'config.json');
		fs.writeFileSync(file, JSON.stringify({ systemPrompt: 'from-file' }), 'utf8');
		const parsed = parseFileConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
		assert.strictEqual(parsed.settings.systemPrompt, 'from-file');
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

suite('admin policy', () => {
	teardown(() => {
		resetAdminPolicyForTests();
		delete process.env.HARATSAN_ADMIN_POLICY;
	});

	test('parseAdminPolicy: только ADMIN_POLICY_KEYS', () => {
		const parsed = parseAdminPolicy({
			$schema: './schemas/haratsan-policy.schema.json',
			webSearchEnabled: false,
			systemPrompt: 'ignored',
			providerUsePatterns: ['corp-*', ''],
			otelEnabled: false,
		});
		assert.strictEqual(parsed.settings.webSearchEnabled, false);
		assert.strictEqual(parsed.settings.otelEnabled, false);
		assert.strictEqual((parsed.settings as { systemPrompt?: unknown }).systemPrompt, undefined);
		assert.deepStrictEqual(parsed.settings.providerUsePatterns, ['corp-*', '']);
		assert.ok(parsed.lockedKeys.includes('webSearchEnabled'));
		assert.ok(parsed.lockedKeys.includes('providerUsePatterns'));
		assert.ok(parsed.lockedKeys.includes('otelEnabled'));
	});

	test('matchAdminPattern: * wildcards', () => {
		assert.ok(matchAdminPattern('corp-*', 'corp-jira'));
		assert.ok(matchAdminPattern('*-prod', 'api-prod'));
		assert.ok(matchAdminPattern('*', 'any'));
		assert.ok(!matchAdminPattern('corp-*', 'other'));
	});

	test('resolveAdminPolicyCandidates: HARATSAN_ADMIN_POLICY wins', () => {
		const custom = path.join(os.tmpdir(), 'haratsan-admin-policy.json');
		process.env.HARATSAN_ADMIN_POLICY = custom;
		assert.deepStrictEqual(resolveAdminPolicyCandidates(), [path.resolve(custom)]);
	});

	test('applyAdminPolicy: force keys', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-admin-'));
		const file = path.join(dir, 'policy.json');
		fs.writeFileSync(
			file,
			JSON.stringify({
				webSearchEnabled: false,
				allowExternalDirectory: false,
				providerUsePolicy: 'deny',
				providerUsePatterns: ['blocked-*'],
			}),
			'utf8',
		);
		process.env.HARATSAN_ADMIN_POLICY = file;
		const snap = await reloadAdminPolicy();
		assert.strictEqual(snap.active, true);
		assert.ok(snap.lockedKeys.includes('webSearchEnabled'));

		const merged = applyAdminPolicy({
			webSearchEnabled: true,
			allowExternalDirectory: true,
			providerUsePolicy: 'allow',
			providerUsePatterns: [],
		});
		assert.strictEqual(merged.webSearchEnabled, false);
		assert.strictEqual(merged.allowExternalDirectory, false);
		assert.strictEqual(merged.providerUsePolicy, 'deny');
		assert.deepStrictEqual(merged.providerUsePatterns, ['blocked-*']);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('reloadAdminPolicy: missing HARATSAN_ADMIN_POLICY * inactive', async () => {
		process.env.HARATSAN_ADMIN_POLICY = path.join(os.tmpdir(), 'haratsan-no-such-policy.json');
		const snap = await reloadAdminPolicy();
		assert.strictEqual(snap.active, false);
		assert.deepStrictEqual(snap.lockedKeys, []);
	});
});
