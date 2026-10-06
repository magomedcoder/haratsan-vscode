import * as assert from 'assert';
import { LogFileWriter, type LogFs } from '../core/log/fileWriter.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((ok) => {
		resolve = ok;
	});
	return { promise, resolve };
}

function memoryFs(): LogFs & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		mkdir: async () => undefined,
		appendFile: async (file, data) => {
			files.set(file, `${files.get(file) ?? ''}${data}`);
		},
		statSize: async (file) => files.get(file)?.length ?? 0,
		rename: async (from, to) => {
			const data = files.get(from);
			if (data !== undefined) {
				files.set(to, data);
				files.delete(from);
			}
		},
	};
}

suite('LogFileWriter', () => {
	test('enqueue возвращается до окончания записи', async () => {
		const gate = deferred();
		let finished = false;
		const fs: LogFs = {
			mkdir: async () => undefined,
			appendFile: async () => {
				await gate.promise;
				finished = true;
			},
			statSize: async () => 0,
			rename: async () => undefined,
		};
		const writer = new LogFileWriter(fs);

		writer.enqueue('/tmp/haratsan.log', 'line-1');
		assert.strictEqual(finished, false);

		gate.resolve();
		await writer.idle();
		assert.strictEqual(finished, true);
	});

	test('ошибка записи не пробрасывается и не копит очередь', async () => {
		const fs: LogFs = {
			mkdir: async () => undefined,
			appendFile: async () => {
				throw new Error('disk full');
			},
			statSize: async () => 0,
			rename: async () => undefined,
		};
		const writer = new LogFileWriter(fs);
		writer.enqueue('/tmp/haratsan.log', 'line-1');
		await writer.idle();
	});

	test('строки дописываются пачкой', async () => {
		const fs = memoryFs();
		const writer = new LogFileWriter(fs);
		writer.enqueue('/tmp/haratsan.log', 'a');
		writer.enqueue('/tmp/haratsan.log', 'b');
		await writer.idle();
		assert.strictEqual(fs.files.get('/tmp/haratsan.log'), 'a\nb\n');
	});

	test('ротация при превышении размера', async () => {
		const fs = memoryFs();
		fs.files.set('/tmp/haratsan.log', 'old');
		const writer = new LogFileWriter(fs, 500, 2);
		writer.enqueue('/tmp/haratsan.log', 'new');
		await writer.idle();
		assert.strictEqual(fs.files.get('/tmp/haratsan.log.1'), 'old');
		assert.strictEqual(fs.files.get('/tmp/haratsan.log'), 'new\n');
	});
});
