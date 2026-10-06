import type { ExtensionContext, Memento } from 'vscode';

export interface ModelUsage {
	promptTokens: number;
	completionTokens: number;
	requests: number;
	lastUsed: number;
}

const STORAGE_KEY = 'haratsan.usage.byModel';

let store: Memento | undefined;
const memory = new Map<string, ModelUsage>();

export function initUsageStore(context: ExtensionContext): void {
	store = context.globalState;
	const raw = store.get<Record<string, ModelUsage>>(STORAGE_KEY, {});
	for (const [key, value] of Object.entries(raw)) {
		memory.set(key, value);
	}
}

export function recordUsage(model: string, promptTokens: number, completionTokens: number): void {
	const id = model.trim() || 'unknown';
	const prev = memory.get(id) ?? {
		promptTokens: 0,
		completionTokens: 0,
		requests: 0,
		lastUsed: 0
	};
	const next: ModelUsage = {
		promptTokens: prev.promptTokens + Math.max(0, promptTokens),
		completionTokens: prev.completionTokens + Math.max(0, completionTokens),
		requests: prev.requests + 1,
		lastUsed: Date.now(),
	};
	memory.set(id, next);
	if (store) {
		void store.update(STORAGE_KEY, Object.fromEntries(memory.entries()));
	}
}

export function getUsageMap(): Record<string, ModelUsage> {
	return Object.fromEntries(memory.entries());
}

// Алиас для UI Usage & Quota
export function readUsage(): Record<string, ModelUsage> {
	return getUsageMap();
}

export function resetUsage(): void {
	memory.clear();
	if (store) {
		void store.update(STORAGE_KEY, {});
	}
}
