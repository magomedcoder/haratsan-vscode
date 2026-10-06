import * as vscode from 'vscode';
import { getProjectMap, PROJECT_MAP_LIMITS } from '../../../index/projectMap';
import { asBoolean, asOptionalInt, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';

export const projectMapTool: ToolDefinition = {
	name: 'project_map',
	description: 'Дерево модулей проекта с краткими summary файлов/папок (+ TS outline exports). Кэш в VS Code workspace storage (источник: индекс или scan с gitignore/.haratsanignore).',
	parameters: {
		type: 'object',
		properties: {
			refresh: {
				type: 'boolean',
				description: 'Принудительно пересобрать карту (игнорировать кэш)',
			},
			max_depth: {
				type: 'integer',
				description: `Максимальная глубина дерева (по умолчанию ${PROJECT_MAP_LIMITS.defaultMaxDepth}, max ${PROJECT_MAP_LIMITS.maxDepthCap})`,
			},
		},
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);

		if (!vscode.workspace.workspaceFolders?.length) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.indexNotInit'),
			};
		}

		try {
			const result = await getProjectMap({
				refresh: asBoolean(args, 'refresh', false),
				maxDepth: asOptionalInt(args, 'max_depth'),
			});
			return {
				ok: true,
				content: result.text,
			};
		} catch (err) {
			return {
				ok: false,
				content: err instanceof Error ? err.message : String(err),
			};
		}
	},
};
