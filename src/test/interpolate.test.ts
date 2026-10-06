import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { interpolateConfigString } from '../core/config/interpolate.js';

suite('interpolateConfigString', () => {
	const prevEnv = { ...process.env };

	teardown(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in prevEnv)) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(prevEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test('${env:NAME} и {env:NAME} подставляют значение', () => {
		process.env.HARATSAN_INTERP_TEST = 'secret-value';
		assert.strictEqual(
			interpolateConfigString('token=${env:HARATSAN_INTERP_TEST}', { cwd: os.tmpdir() }),
			'token=secret-value',
		);
		assert.strictEqual(
			interpolateConfigString('token={env:HARATSAN_INTERP_TEST}', { cwd: os.tmpdir() }),
			'token=secret-value',
		);
	});

	test('отсутствующий env даёт пустую строку без throw', () => {
		delete process.env.HARATSAN_INTERP_MISSING;
		assert.strictEqual(
			interpolateConfigString('x=${env:HARATSAN_INTERP_MISSING}-y', { cwd: os.tmpdir() }),
			'x=-y',
		);
		assert.strictEqual(
			interpolateConfigString('x={env:HARATSAN_INTERP_MISSING}-y', { cwd: os.tmpdir() }),
			'x=-y',
		);
	});

	test('{file:path} читает файл относительно cwd', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-interp-'));
		const file = path.join(dir, 'token.txt');
		fs.writeFileSync(file, 'from-file', 'utf8');
		assert.strictEqual(
			interpolateConfigString('key={file:token.txt}', { cwd: dir }),
			'key=from-file',
		);
		assert.strictEqual(
			interpolateConfigString('key={file:' + file + '}', { cwd: dir }),
			'key=from-file',
		);
	});

	test('отсутствующий файл даёт пустую строку', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-interp-'));
		assert.strictEqual(
			interpolateConfigString('a={file:no-such.txt}b', { cwd: dir }),
			'a=b',
		);
	});

	test('{file:...} обрезает по maxFileBytes', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-interp-'));
		const file = path.join(dir, 'big.txt');
		fs.writeFileSync(file, 'abcdefghij', 'utf8');
		assert.strictEqual(
			interpolateConfigString('{file:big.txt}', { cwd: dir, maxFileBytes: 4 }),
			'abcd',
		);
	});

	test('строка без плейсхолдеров не меняется', () => {
		assert.strictEqual(interpolateConfigString('plain'), 'plain');
	});
});
