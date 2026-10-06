import type { ChatMode } from '../../../core/config/types';
import type { ToolDefinition } from '../types';

export type ToolTag = 'fs' | 'search' | 'shell' | 'ide' | 'plan' | 'meta';

// Риск для approval / фильтров (этап 2; permissionPolicy пока по имени)
export type ToolRisk = 'read' | 'write' | 'shell' | 'web';

export type ToolSource = 'builtin' | 'dynamic' | 'ephemeral';

export interface ToolMeta {
	tags: ToolTag[];
	risk: ToolRisk;
	modes?: ChatMode[];
	timeoutMs?: number;
}

interface RegistryEntry {
	tool: ToolDefinition;
	meta?: ToolMeta;
	source: ToolSource;
}

const BY_NAME = new Map<string, RegistryEntry>();

/**
 * Регистрация builtin / dynamic / ephemeral tool.
 * Dynamic заменяет предыдущий dynamic; ephemeral - предыдущий ephemeral.
 * Builtin не перекрывается.
 */
export function registerTool(
	tool: ToolDefinition,
	meta?: ToolMeta,
	source: ToolSource = 'builtin',
): void {
	const existing = BY_NAME.get(tool.name);
	if (existing && existing.tool !== tool) {
		const canReplace =
			(source === 'dynamic' && existing.source === 'dynamic')
			|| (source === 'ephemeral' && existing.source === 'ephemeral');
		if (!canReplace) {
			throw new Error(`Tool already registered: ${tool.name}`);
		}
	}

	BY_NAME.set(tool.name, {
		tool,
		meta: meta ?? existing?.meta,
		source,
	});
}

export function getToolByName(name: string): ToolDefinition | undefined {
	return BY_NAME.get(name)?.tool;
}

export function getToolMeta(name: string): ToolMeta | undefined {
	return BY_NAME.get(name)?.meta;
}

export function getToolSource(name: string): ToolSource | undefined {
	return BY_NAME.get(name)?.source;
}

// Снимок зарегистрированных tools (порядок вставки)
export function listTools(): ToolDefinition[] {
	return [...BY_NAME.values()].map((e) => e.tool);
}

export function listToolsByTag(tag: ToolTag): ToolDefinition[] {
	return [...BY_NAME.values()].filter((e) => e.meta?.tags.includes(tag))
		.map((e) => e.tool);
}

// Снять все dynamic (перед refresh `.haratsan/tools`)
export function unregisterDynamicTools(): void {
	for (const [name, entry] of [...BY_NAME.entries()]) {
		if (entry.source === 'dynamic') {
			BY_NAME.delete(name);
		}
	}
}

// Снять ephemeral tools (конец AgentSession turn)
export function unregisterEphemeralTools(): void {
	for (const [name, entry] of [...BY_NAME.entries()]) {
		if (entry.source === 'ephemeral') {
			BY_NAME.delete(name);
		}
	}
}

// Имя для ephemeral tools API: [a-z0-9_-]
export function sanitizeEphemeralToolName(raw: string): string {
	const cleaned = raw.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.replace(/_+/g, '_');
	return cleaned.slice(0, 64) || 'ephemeral_tool';
}

// Только для unit-тестов
export function clearToolsForTests(): void {
	BY_NAME.clear();
}
