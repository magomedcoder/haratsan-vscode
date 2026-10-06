import type { HaratsanSettings } from '../config/types';

// Запас поверх completion + compactReserved
export const CONTEXT_SAFETY_MARGIN = 256;

// Порог «почти полный» контекст - mid-loop prune
export const CONTEXT_NEAR_BUDGET_RATIO = 0.85;

const nCtxCache = new Map<string, number>();

function cacheKey(baseUrl: string, model: string): string {
	return `${baseUrl.trim()}|${model.trim()}`;
}

export function getCachedNCtx(baseUrl: string, model: string): number | undefined {
	const key = cacheKey(baseUrl, model);
	if (!key || key === '|') {
		return undefined;
	}

	return nCtxCache.get(key);
}

export function setCachedNCtx(baseUrl: string, model: string, nCtx: number): void {
	const key = cacheKey(baseUrl, model);
	if (!key || key === '|' || !Number.isFinite(nCtx) || nCtx < 512) {
		return;
	}

	nCtxCache.set(key, Math.floor(nCtx));
}

// Soft-update кэша n_ctx из тела chat/completions (если сервер отдал поле)
export function softCacheNCtxFromCompletePayload(baseUrl: string, model: string, data: unknown): void {
	if (!data || typeof data !== 'object') {
		return;
	}

	const root = data as Record<string, unknown>;
	const nCtx = extractNCtxFromProps(root)
		?? extractNCtxFromProps(root.usage)
		?? extractNCtxFromProps(root.timings)
		?? extractNCtxFromProps(root.stats);
	if (nCtx) {
		setCachedNCtx(baseUrl, model, nCtx);
	}
}

export function clearCachedNCtx(baseUrl?: string, model?: string): void {
	if (baseUrl === undefined && model === undefined) {
		nCtxCache.clear();
		return;
	}

	nCtxCache.delete(cacheKey(baseUrl ?? '', model ?? ''));
}

// Эффективный budget промпта: min(maxContextTokens, n_ctx?) − maxTokens(completion) − compactReserved − safety
export function getEffectiveContextBudget(settings: HaratsanSettings, nCtx?: number): number {
	const windowSize = Math.min(
		settings.maxContextTokens,
		nCtx ?? settings.maxContextTokens,
	);
	const completionReserve = Math.min(
		Math.max(64, settings.maxTokens),
		Math.floor(windowSize / 2),
	);
	const reserved = completionReserve + Math.max(0, settings.compactReservedTokens) + CONTEXT_SAFETY_MARGIN;
	
	return Math.max(1024, windowSize - reserved);
}

export function isNearContextBudget(estimatedTokens: number, budget: number): boolean {
	return estimatedTokens >= budget * CONTEXT_NEAR_BUDGET_RATIO;
}

export function isOverContextBudget(estimatedTokens: number, budget: number): boolean {
	return estimatedTokens > budget;
}

// Достать n_ctx из /props llama.cpp или похожего JSON
export function extractNCtxFromProps(data: unknown): number | undefined {
	if (!data || typeof data !== 'object') {
		return undefined;
	}

	const root = data as Record<string, unknown>;
	const direct = asPositiveCtx(root.n_ctx ?? root.n_ctx_train ?? root.context_size ?? root.context_length);
	if (direct) {
		return direct;
	}

	const gen = root.default_generation_settings;
	if (gen && typeof gen === 'object') {
		const g = gen as Record<string, unknown>;
		const fromGen = asPositiveCtx(g.n_ctx ?? g.n_ctx_train ?? g.context_size);
		if (fromGen) {
			return fromGen;
		}
	}

	return undefined;
}

// Достать n_ctx из /v1/models payload (meta / max_model_len)
export function extractNCtxFromModelsPayload(data: unknown, modelId?: string): number | undefined {
	if (!data || typeof data !== 'object') {
		return undefined;
	}

	const root = data as Record<string, unknown>;
	const want = modelId?.trim();
	const rows: unknown[] = [];
	if (Array.isArray(root.data)) {
		rows.push(...root.data);
	}
	if (Array.isArray(root.models)) {
		rows.push(...root.models);
	}

	let fallback: number | undefined;
	for (const row of rows) {
		if (!row || typeof row !== 'object') {
			continue;
		}

		const item = row as Record<string, unknown>;
		const id = typeof item.id === 'string' ? item.id.trim() : typeof item.name === 'string' ? item.name.trim() : '';
		const n = nCtxFromModelRow(item);
		if (!n) {
			continue;
		}

		if (want && id && id === want) {
			return n;
		}

		fallback ??= n;
	}

	return want ? fallback : fallback;
}

function nCtxFromModelRow(item: Record<string, unknown>): number | undefined {
	const direct = asPositiveCtx(
		item.n_ctx
		?? item.n_ctx_train
		?? item.max_model_len
		?? item.context_length
		?? item.context_size,
	);
	if (direct) {
		return direct;
	}

	const meta = item.meta;
	if (meta && typeof meta === 'object') {
		const m = meta as Record<string, unknown>;
		return asPositiveCtx(m.n_ctx ?? m.n_ctx_train ?? m.max_model_len ?? m.context_length);
	}

	return undefined;
}

function asPositiveCtx(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(n) || n < 512) {
		return undefined;
	}

	return Math.floor(n);
}
