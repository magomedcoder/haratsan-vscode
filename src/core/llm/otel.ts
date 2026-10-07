import { randomBytes } from 'node:crypto';
import type { HaratsanSettings } from '../config/types';
import { appendLogLine } from '../log/logger';
import type { TokenUsage } from './usage';

// Атрибуты завершённого span для llm.complete (без секретов)
export interface LlmSpanEndAttrs {
	model: string;
	status: 'ok' | 'error';
	durationMs: number;
	usage?: TokenUsage;
	// Хост baseUrl (без path/query/credentials)
	providerHost?: string;
}

export interface LlmSpanHandle {
	end(attrs: LlmSpanEndAttrs): void;
}

// Только hostname из baseUrl - без ключей и path
export function providerHostFromBaseUrl(baseUrl: string): string | undefined {
	const raw = baseUrl.trim();
	if (!raw) {
		return undefined;
	}

	try {
		const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
		return url.host || undefined;
	} catch {
		return undefined;
	}
}

function hexId(bytes: number): string {
	return randomBytes(bytes).toString('hex');
}

function otlpStringAttr(key: string, value: string): { key: string; value: { stringValue: string } } {
	return { 
		key, 
		value: { 
			stringValue: value 
		} 
	};
}

function otlpIntAttr(key: string, value: number): { key: string; value: { intValue: string } } {
	return { 
		key, 
		value: { 
			intValue: String(Math.floor(value)) 
		} 
	};
}

// Собирает OTLP/JSON ExportTraceServiceRequest с одним span
function buildOtlpJsonPayload(attrs: LlmSpanEndAttrs, startNs: bigint, endNs: bigint): string {
	const attributes = [
		otlpStringAttr('haratsan.llm.model', attrs.model || 'unknown'),
		otlpStringAttr('haratsan.llm.status', attrs.status),
		otlpIntAttr('haratsan.llm.duration_ms', attrs.durationMs),
	];
	if (attrs.providerHost) {
		attributes.push(otlpStringAttr('haratsan.llm.provider_host', attrs.providerHost));
	}

	if (attrs.usage) {
		attributes.push(otlpIntAttr('haratsan.llm.tokens.input', attrs.usage.promptTokens));
		attributes.push(otlpIntAttr('haratsan.llm.tokens.output', attrs.usage.completionTokens));
		attributes.push(otlpIntAttr('haratsan.llm.tokens.total', attrs.usage.totalTokens));
	}

	const body = {
		resourceSpans: [
			{
				resource: {
					attributes: [otlpStringAttr('service.name', 'haratsan-vscode')],
				},
				scopeSpans: [
					{
						scope: {
							name: 'haratsan.llm',
							version: '0.1.0',
						},
						spans: [
							{
								traceId: hexId(16),
								spanId: hexId(8),
								name: 'llm.complete',
								kind: 3,
								startTimeUnixNano: startNs.toString(),
								endTimeUnixNano: endNs.toString(),
								attributes,
								status: {
									code: attrs.status === 'ok' ? 1 : 2,
								},
							},
						],
					},
				],
			},
		],
	};
	return JSON.stringify(body);
}

function formatConsoleLine(attrs: LlmSpanEndAttrs): string {
	const ts = new Date().toISOString();
	const host = attrs.providerHost ? ` host=${attrs.providerHost}` : '';
	const tokens = attrs.usage
		? ` in=${attrs.usage.promptTokens} out=${attrs.usage.completionTokens}`
		: '';
	return `[${ts}] otel llm.complete model=${attrs.model || '-'} status=${attrs.status} ${attrs.durationMs}ms${host}${tokens}`;
}

async function postOtlp(endpoint: string, payload: string): Promise<void> {
	try {
		await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: payload,
		});
	} catch {}
}

/**
 * Opt-in span вокруг HttpLlmClient.complete.
 * otelEnabled=false * no-op; без endpoint * строка в Haratsan LLM Output; с endpoint * OTLP/JSON HTTP.
 */
export function beginLlmCompleteSpan(
	settings: Pick<HaratsanSettings, 'otelEnabled' | 'otelEndpoint' | 'baseUrl'>,
): LlmSpanHandle | undefined {
	if (!settings.otelEnabled) {
		return undefined;
	}

	const startMs = Date.now();
	const startNs = BigInt(startMs) * 1_000_000n;
	const endpoint = settings.otelEndpoint.trim();
	const providerHost = providerHostFromBaseUrl(settings.baseUrl);

	return {
		end(attrs: LlmSpanEndAttrs): void {
			const durationMs = attrs.durationMs >= 0 ? attrs.durationMs : Date.now() - startMs;
			const endAttrs: LlmSpanEndAttrs = {
				...attrs,
				durationMs,
				providerHost: attrs.providerHost ?? providerHost,
			};
			const endNs = startNs + BigInt(Math.max(0, durationMs)) * 1_000_000n;

			if (!endpoint) {
				appendLogLine('llm', formatConsoleLine(endAttrs));
				return;
			}

			const payload = buildOtlpJsonPayload(endAttrs, startNs, endNs);
			void postOtlp(endpoint, payload);
		},
	};
}

export interface IndexMerkleOtelAttrs {
	filesTotal: number;
	filesSkipped: number;
	filesIndexed: number;
	dirsTotal: number;
	dirsSkipped: number;
	chunksIndexed: number;
	chunksSkipped: number;
	folderKey?: string;
}

/**
 * Опциональный OTLP/консольный span с метриками skip Merkle на fullIndex.
 * Тот же флаг, что у LLM: `otelEnabled` (+ опционально `otelEndpoint`).
 */
export function emitIndexMerkleMetrics(
	settings: Pick<HaratsanSettings, 'otelEnabled' | 'otelEndpoint'>,
	attrs: IndexMerkleOtelAttrs,
): void {
	if (!settings.otelEnabled) {
		return;
	}

	const startMs = Date.now();
	const startNs = BigInt(startMs) * 1_000_000n;
	const endNs = startNs + 1_000_000n;
	const line = `[${new Date().toISOString()}] otel index.full ` +
		`files=${attrs.filesIndexed}/${attrs.filesTotal} skip=${attrs.filesSkipped} ` +
		`dirsSkip=${attrs.dirsSkipped}/${attrs.dirsTotal} ` +
		`chunks=+${attrs.chunksIndexed}/reuse=${attrs.chunksSkipped}` +
		(attrs.folderKey ? ` folder=${attrs.folderKey}` : '');
	const endpoint = settings.otelEndpoint.trim();
	if (!endpoint) {
		appendLogLine('llm', line);
		return;
	}

	const attributes = [
		otlpStringAttr('haratsan.index.op', 'full'),
		otlpIntAttr('haratsan.index.files_total', attrs.filesTotal),
		otlpIntAttr('haratsan.index.files_skipped', attrs.filesSkipped),
		otlpIntAttr('haratsan.index.files_indexed', attrs.filesIndexed),
		otlpIntAttr('haratsan.index.dirs_total', attrs.dirsTotal),
		otlpIntAttr('haratsan.index.dirs_skipped', attrs.dirsSkipped),
		otlpIntAttr('haratsan.index.chunks_indexed', attrs.chunksIndexed),
		otlpIntAttr('haratsan.index.chunks_skipped', attrs.chunksSkipped),
	];
	if (attrs.folderKey) {
		attributes.push(otlpStringAttr('haratsan.index.folder_key', attrs.folderKey));
	}
	const body = {
		resourceSpans: [
			{
				resource: {
					attributes: [otlpStringAttr('service.name', 'haratsan-vscode')],
				},
				scopeSpans: [
					{
						scope: { 
							name: 'haratsan.index', 
							version: '0.1.0' 
						},
						spans: [
							{
								traceId: hexId(16),
								spanId: hexId(8),
								name: 'index.full',
								kind: 3,
								startTimeUnixNano: startNs.toString(),
								endTimeUnixNano: endNs.toString(),
								attributes,
								status: { 
									code: 1 
								},
							},
						],
					},
				],
			},
		],
	};
	void postOtlp(endpoint, JSON.stringify(body));
}

export interface TreeSitterOtelAttrs {
	ok: number;
	fail: number;
	timeout: number;
	oversized: number;
	cacheHit: number;
	lastError?: string;
}

// Опциональный span `index.treesitter` со счётчиками разбора
export function emitTreeSitterMetrics(
	settings: Pick<HaratsanSettings, 'otelEnabled' | 'otelEndpoint'>,
	attrs: TreeSitterOtelAttrs,
): void {
	if (!settings.otelEnabled) {
		return;
	}

	const startMs = Date.now();
	const startNs = BigInt(startMs) * 1_000_000n;
	const endNs = startNs + 1_000_000n;
	const line = `[${new Date().toISOString()}] otel index.treesitter ` +
		`ok=${attrs.ok} fail=${attrs.fail} timeout=${attrs.timeout} ` +
		`oversized=${attrs.oversized} cacheHit=${attrs.cacheHit}` +
		(attrs.lastError ? ` err=${attrs.lastError}` : '');
	const endpoint = settings.otelEndpoint.trim();
	if (!endpoint) {
		appendLogLine('llm', line);
		return;
	}

	const attributes = [
		otlpStringAttr('haratsan.index.op', 'treesitter'),
		otlpIntAttr('haratsan.treesitter.ok', attrs.ok),
		otlpIntAttr('haratsan.treesitter.fail', attrs.fail),
		otlpIntAttr('haratsan.treesitter.timeout', attrs.timeout),
		otlpIntAttr('haratsan.treesitter.oversized', attrs.oversized),
		otlpIntAttr('haratsan.treesitter.cache_hit', attrs.cacheHit),
	];

	if (attrs.lastError) {
		attributes.push(otlpStringAttr('haratsan.treesitter.last_error', attrs.lastError.slice(0, 200)));
	}

	const body = {
		resourceSpans: [
			{
				resource: {
					attributes: [otlpStringAttr('service.name', 'haratsan-vscode')],
				},
				scopeSpans: [
					{
						scope: { 
							name: 'haratsan.index', 
							version: '0.1.0' 
						},
						spans: [
							{
								traceId: hexId(16),
								spanId: hexId(8),
								name: 'index.treesitter',
								kind: 3,
								startTimeUnixNano: startNs.toString(),
								endTimeUnixNano: endNs.toString(),
								attributes,
								status: { 
									code: attrs.fail > attrs.ok ? 2 : 1 
								},
							},
						],
					},
				],
			},
		],
	};
	void postOtlp(endpoint, JSON.stringify(body));
}
