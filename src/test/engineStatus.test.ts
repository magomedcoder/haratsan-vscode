import * as assert from 'node:assert';
import { resolveIndexEngineMode } from '../features/index/engineStatus.js';

const baseSettings = {
	embeddingsBaseUrl: '',
	baseUrl: '',
	localEmbeddingsMode: 'off' as const,
};

suite('index engine status', () => {
	test('без URL - CPU trigram', () => {
		assert.strictEqual(resolveIndexEngineMode(baseSettings), 'cpu-trigram');
		assert.strictEqual(resolveIndexEngineMode({
			...baseSettings,
			embeddingsBaseUrl: '  ',
		}), 'cpu-trigram');
	});

	test('с embeddingsBaseUrl - remote', () => {
		assert.strictEqual(
			resolveIndexEngineMode({
				...baseSettings,
				embeddingsBaseUrl: 'https://api.example/v1',
			}),
			'remote',
		);
	});

	test('с baseUrl без embeddingsBaseUrl - remote', () => {
		assert.strictEqual(
			resolveIndexEngineMode({
				...baseSettings,
				baseUrl: 'https://llm.example/v1',
			}),
			'remote',
		);
	});

	test('localEmbeddingsMode=vector - local-vector (даже с remote URL)', () => {
		assert.strictEqual(
			resolveIndexEngineMode({
				...baseSettings,
				embeddingsBaseUrl: 'https://api.example/v1',
				localEmbeddingsMode: 'vector',
			}),
			'local-vector',
		);
	});
});
