import * as assert from 'assert';
import { createIgnoreMatcher, ignoresRelative } from '../features/agent/gitIgnore.js';

suite('gitIgnore matcher', () => {
	test('пусто - ничего не игнорирует кроме .git', () => {
		const ig = createIgnoreMatcher([]);
		assert.ok(!ignoresRelative(ig, 'src/index.ts'));
		assert.ok(!ignoresRelative(ig, 'vendor/lib.go'));
		assert.ok(ignoresRelative(ig, '.git'));
		assert.ok(ignoresRelative(ig, '.git/config'));
	});

	test('gitignore-паттерны закрывают vendor и target', () => {
		const ig = createIgnoreMatcher(['vendor/', 'target/', 'node_modules/', '*.log']);
		assert.ok(ignoresRelative(ig, 'vendor/pkg/mod.go'));
		assert.ok(ignoresRelative(ig, 'target/debug/app'));
		assert.ok(ignoresRelative(ig, 'node_modules/left-pad/index.js'));
		assert.ok(ignoresRelative(ig, 'build.log'));
		assert.ok(!ignoresRelative(ig, 'src/main.go'));
	});

	test('haratsanignore-подобные шаблоны', () => {
		const ig = createIgnoreMatcher(['secrets/', '*.pem', '.env']);
		assert.ok(ignoresRelative(ig, 'secrets/token.txt'));
		assert.ok(ignoresRelative(ig, 'certs/server.pem'));
		assert.ok(ignoresRelative(ig, '.env'));
		assert.ok(!ignoresRelative(ig, 'src/app.ts'));
	});

	test('комментарии и пустые строки игнорируются', () => {
		const ig = createIgnoreMatcher(['# comment', '', '  ', 'dist/']);
		assert.ok(ignoresRelative(ig, 'dist/bundle.js'));
		assert.ok(!ignoresRelative(ig, 'src/a.ts'));
	});

	test('корень workspace не игнорируется', () => {
		const ig = createIgnoreMatcher(['*']);
		assert.ok(!ignoresRelative(ig, '.'));
		assert.ok(!ignoresRelative(ig, ''));
	});

	test('отрицание ! re-include возвращает путь', () => {
		const ig = createIgnoreMatcher(['*.log', '!important.log', 'dist/**', '!dist/keep.js']);
		assert.ok(ignoresRelative(ig, 'build.log'));
		assert.ok(!ignoresRelative(ig, 'important.log'));
		assert.ok(ignoresRelative(ig, 'dist/other.js'));
		assert.ok(!ignoresRelative(ig, 'dist/keep.js'));
	});
});
