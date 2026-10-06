import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildPathEnv, mergeEnvLayers, parseShellProfilesJson, resolveShellProfileEnv } from '../features/project/shellProfiles.js';

suite('shellProfiles', () => {
	test('parse named profiles + defaultProfile', () => {
		const cfg = parseShellProfilesJson({
			version: 1,
			defaultProfile: 'dev',
			profiles: {
				dev: { 
					env: { NODE_ENV: 'development' },
					pathPrepend: ['node_modules/.bin']
				},
				ci: { env: { CI: '1' } },
			},
		});
		assert.ok(cfg);
		assert.equal(cfg!.defaultProfile, 'dev');
		assert.equal(cfg!.profiles.dev?.env?.NODE_ENV, 'development');
		assert.deepEqual(cfg!.profiles.dev?.pathPrepend, ['node_modules/.bin']);
	});

	test('parse shorthand env -> default profile', () => {
		const cfg = parseShellProfilesJson({
			env: { FOO: 'bar' },
			pathAppend: ['tools'],
		});
		assert.ok(cfg);
		assert.equal(cfg!.profiles.default?.env?.FOO, 'bar');
		assert.deepEqual(cfg!.profiles.default?.pathAppend, ['tools']);
	});

	test('resolve picks explicit > HARATSAN_SHELL_PROFILE > defaultProfile', () => {
		const config = parseShellProfilesJson({
			defaultProfile: 'dev',
			profiles: {
				dev: { env: { A: 'dev' } },
				ci: { env: { A: 'ci' } },
			},
		});
		assert.equal(
			resolveShellProfileEnv({ config, profileName: 'ci', envProfileOverride: 'dev' }).env.A,
			'ci',
		);
		assert.equal(
			resolveShellProfileEnv({ config, envProfileOverride: 'ci' }).env.A,
			'ci',
		);
		assert.equal(resolveShellProfileEnv({ config }).env.A, 'dev');
	});

	test('unknown profile -> error', () => {
		const config = parseShellProfilesJson({
			profiles: { 
				dev: { 
					env: { A: '1' } 
				} 
			},
		});
		const r = resolveShellProfileEnv({ config, profileName: 'missing' });
		assert.ok(r.error);
		assert.equal(Object.keys(r.env).length, 0);
	});

	test('buildPathEnv prepend/append + resolve relative', () => {
		const root = '/ws';
		const built = buildPathEnv({
			basePath: ['/usr/bin', '/bin'].join(path.delimiter),
			prepend: ['node_modules/.bin'],
			append: ['/opt/extra'],
			workspaceRoot: root,
		});
		assert.ok(built);
		const parts = built!.split(path.delimiter);
		assert.equal(parts[0], path.resolve(root, 'node_modules/.bin'));
		assert.ok(parts.includes('/usr/bin'));
		assert.equal(parts[parts.length - 1], '/opt/extra');
	});

	test('pathPrepend пишет PATH в overlay', () => {
		const config = parseShellProfilesJson({
			profiles: {
				default: {
					pathPrepend: ['bin'], 
					env: { X: '1' }
				},
			},
		});
		const r = resolveShellProfileEnv({
			config,
			basePath: '/usr/bin',
			workspaceRoot: '/proj',
		});
		assert.equal(r.env.X, '1');
		assert.ok(r.env.PATH?.startsWith(path.resolve('/proj', 'bin')));
	});

	test('mergeEnvLayers: поздний перекрывает', () => {
		assert.deepEqual(
			mergeEnvLayers({ A: '1', B: '2' }, { B: '3', C: '4' }),
			{ A: '1', B: '3', C: '4' },
		);
	});
});
