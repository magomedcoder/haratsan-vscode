import type { ExtensionContext, Memento } from 'vscode';

const STORAGE_KEY = 'haratsan.persistedAlwaysAllow';
const MAX_PATTERNS = 200;
const MAX_PATTERN_LEN = 400;

let store: Memento | undefined;

export function initAlwaysAllowStore(context: ExtensionContext): void {
	// workspaceState: паттерны привязаны к workspace, не утекают в JSON-слои
	store = context.workspaceState;
}

function normalizeList(raw: unknown): string[] {
	const list = Array.isArray(raw) ? raw : [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		const line = String(item ?? '').trim().slice(0, MAX_PATTERN_LEN);
		if (!line || seen.has(line)) {
			continue;
		}

		seen.add(line);
		out.push(line);
		if (out.length >= MAX_PATTERNS) {
			break;
		}
	}

	return out;
}

export function getPersistedAlwaysAllow(): string[] {
	if (!store) {
		return [];
	}
	
	return normalizeList(store.get<string[]>(STORAGE_KEY));
}

export async function setPersistedAlwaysAllow(patterns: string[]): Promise<string[]> {
	const next = normalizeList(patterns);
	if (store) {
		await store.update(STORAGE_KEY, next);
	}

	return next;
}

export async function addPersistedAlwaysAllow(pattern: string): Promise<string[]> {
	const line = pattern.trim().slice(0, MAX_PATTERN_LEN);
	if (!line) {
		return getPersistedAlwaysAllow();
	}

	const prev = getPersistedAlwaysAllow();
	if (prev.includes(line)) {
		return prev;
	}

	return setPersistedAlwaysAllow([...prev, line]);
}

export async function clearPersistedAlwaysAllow(): Promise<void> {
	if (store) {
		await store.update(STORAGE_KEY, []);
	}
}

// Смержить persisted * sessionAllow (без дублей)
export function mergeAlwaysAllow(sessionAllow: string[], persisted: readonly string[]): string[] {
	const out = [...sessionAllow];
	const seen = new Set(out);
	for (const p of persisted) {
		const line = p.trim();
		if (!line || seen.has(line)) {
			continue;
		}
		
		seen.add(line);
		out.push(line);
	}

	return out;
}
