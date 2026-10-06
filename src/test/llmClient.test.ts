import * as assert from 'assert';
import { buildAuthHeaders } from '../core/config/apiKey.js';
import { HttpLlmClient } from '../core/llm/client.js';
import { isRetryableError, LlmHttpError, parseRetryAfterMs, retryDelayMs, withCause } from '../core/llm/errors.js';
import type { HaratsanSettings } from '../core/config/types.js';
import { DEFAULT_SETTINGS } from '../core/config/types.js';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function testSettings(over: Partial<HaratsanSettings> = {}): HaratsanSettings {
	return {
		...DEFAULT_SETTINGS,
		baseUrl: 'http://llm.test',
		model: 'test',
		requestTimeoutMs: 5_000,
		...over,
	};
}

suite('buildAuthHeaders', () => {
	test('Bearer по умолчанию', () => {
		assert.deepStrictEqual(buildAuthHeaders('sk-1', 'Authorization', 'Bearer'), {
			Authorization: 'Bearer sk-1',
		});
	});

	test('пустой ключ - нет заголовка', () => {
		assert.deepStrictEqual(buildAuthHeaders('', 'Authorization', 'Bearer'), {});
	});

	test('без схемы - сырой ключ', () => {
		assert.deepStrictEqual(buildAuthHeaders('raw', 'X-Api-Key', ''), {
			'X-Api-Key': 'raw',
		});
	});
});

suite('retry helpers', () => {
	test('429 и 5xx повторяются', () => {
		assert.ok(isRetryableError(new LlmHttpError('x', 429)));
		assert.ok(isRetryableError(new LlmHttpError('x', 503)));
		assert.ok(!isRetryableError(new LlmHttpError('x', 400)));
		assert.ok(isRetryableError(new TypeError('fetch failed')));
	});

	test('backoff растёт', () => {
		assert.strictEqual(retryDelayMs(0), 400);
		assert.strictEqual(retryDelayMs(1), 800);
		assert.strictEqual(retryDelayMs(2), 1600);
	});

	test('Retry-After поднимает задержку и ограничен 60с', () => {
		assert.strictEqual(retryDelayMs(0, 5_000), 5_000);
		assert.strictEqual(retryDelayMs(2, 1_000), 1_600);
		assert.strictEqual(retryDelayMs(0, 120_000), 60_000);
	});

	test('parseRetryAfterMs: delta-seconds и HTTP-date', () => {
		assert.strictEqual(parseRetryAfterMs(null), undefined);
		assert.strictEqual(parseRetryAfterMs(''), undefined);
		assert.strictEqual(parseRetryAfterMs('5'), 5_000);
		assert.strictEqual(parseRetryAfterMs('0'), 0);

		const future = new Date(Date.now() + 10_000).toUTCString();
		const parsed = parseRetryAfterMs(future);
		assert.ok(parsed !== undefined && parsed > 5_000 && parsed <= 10_000);

		assert.strictEqual(parseRetryAfterMs('not-a-date'), undefined);
	});

	test('withCause сохраняет cause', () => {
		const root = new Error('root');
		const wrapped = withCause('outer', root);
		assert.strictEqual(wrapped.cause, root);
	});
});

suite('HttpLlmClient', () => {
	test('повторяет 503 и затем успех', async () => {
		const calls: number[] = [];
		const client = new HttpLlmClient({
			getConfig: () => testSettings(),
			readApiKey: async () => 'sk-test',
			sleep: async () => undefined,
			fetch: async (url, init) => {
				const href = String(url);
				if (href.includes('/props')) {
					return jsonResponse({}, 404);
				}

				calls.push(1);
				const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
				assert.strictEqual(auth, 'Bearer sk-test');
				if (calls.length === 1) {
					return jsonResponse({
						error: {
							message: 'busy'
						}
					}, 503);
				}

				return jsonResponse({
					data: [{
						id: 'gpt'
					}]
				});
			},
		});

		const models = await client.listModels();
		assert.deepStrictEqual(models, ['gpt']);
		assert.strictEqual(calls.length, 2);
	});

	test('400 не ретраится', async () => {
		let calls = 0;
		const client = new HttpLlmClient({
			getConfig: () => testSettings(),
			readApiKey: async () => '',
			sleep: async () => undefined,
			fetch: async (url) => {
				if (String(url).includes('/props')) {
					return jsonResponse({}, 404);
				}

				calls += 1;
				return jsonResponse({
					error: {
						message: 'bad'
					}
				}, 400);
			},
		});

		await assert.rejects(
			() => client.listModels(),
			(err: unknown) => err instanceof LlmHttpError && err.status === 400,
		);
		assert.strictEqual(calls, 1);
	});

	test('кэширует n_ctx из /props после listModels', async () => {
		const { clearCachedNCtx, getCachedNCtx } = await import('../core/llm/contextBudget.js');
		clearCachedNCtx();
		const client = new HttpLlmClient({
			getConfig: () => testSettings({ 
				baseUrl: 'http://llm.test/v1',
				 model: 'local' 
				}),
			readApiKey: async () => '',
			sleep: async () => undefined,
			fetch: async (url) => {
				const href = String(url);
				if (href.includes('/props')) {
					return jsonResponse({ 
						default_generation_settings: { 
							n_ctx: 8192 
						} 
					});
				}

				return jsonResponse({ 
					data: [{ 
						id: 'local' 
					}] 
				});
			},
		});

		await client.listModels();
		assert.strictEqual(getCachedNCtx('http://llm.test/v1', 'local'), 8192);
		clearCachedNCtx();
	});
});
