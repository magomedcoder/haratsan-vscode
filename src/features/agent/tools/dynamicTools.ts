import type { ToolDefinition } from '../types';
import { discoverLocalPlugins, type LocalPluginInfo } from '../../project/plugins';
import { getToolByName, registerTool, unregisterDynamicTools } from './registry';
import type { ToolMeta } from './registry';
const DYNAMIC_META: ToolMeta = {
	tags: ['meta'],
	risk: 'read',
};

// Имя для LLM tools API: [a-z0-9_-]
export function sanitizeDynamicToolName(raw: string): string {
	const cleaned = raw.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.replace(/_+/g, '_');
	return cleaned.slice(0, 64) || 'local_tool';
}

function resolveFreeToolName(preferred: string): string | undefined {
	const base = sanitizeDynamicToolName(preferred);
	if (!getToolByName(base)) {
		return base;
	}

	const prefixed = sanitizeDynamicToolName(`local_${base}`);
	if (!getToolByName(prefixed)) {
		return prefixed;
	}

	// Builtin занял и base, и local_* - не регистрируем
	return undefined;
}

function buildDynamicTool(item: LocalPluginInfo, name: string): ToolDefinition {
	const body = item.body.trim() || '(пустое описание)';
	const pathHint = item.path;
	return {
		name,
		description: `${item.description} [local .haratsan/tools; no JS]`.slice(0, 300),
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		async execute(): Promise<{ ok: boolean; content: string }> {
			return {
				ok: true,
				content: [
					`# Local tool: ${item.name}`,
					`path: ${pathHint}`,
					'',
					body,
				].join('\n'),
			};
		},
	};
}

/**
 * Пересканировать `.haratsan/tools` markdown и зарегистрировать в registry.
 * JS не исполняется - tool только возвращает тело описания.
 */
export async function refreshDynamicTools(): Promise<string[]> {
	unregisterDynamicTools();
	const items = (await discoverLocalPlugins()).filter((i) => i.kind === 'tool');
	const registered: string[] = [];
	for (const item of items) {
		const name = resolveFreeToolName(item.name);
		if (!name) {
			continue;
		}

		registerTool(buildDynamicTool(item, name), DYNAMIC_META, 'dynamic');
		registered.push(name);
	}

	return registered;
}
