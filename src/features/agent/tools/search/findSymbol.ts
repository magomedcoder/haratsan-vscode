import * as vscode from 'vscode';
import { findInSymbolIndex } from '../../../index/symbolIndex';
import { findInOutlineIndex } from '../../../index/tsOutline';
import { AGENT_LIMITS } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';

const DEFAULT_MAX = 20;

export const findSymbolTool: ToolDefinition = {
	name: 'find_symbol',
	description: 'Поиск символов (классы, функции, методы...) по LSP-кэшу symbols и TS outline (workspace storage). Предпочтительно для «где объявлен X».',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Имя символа или фрагмент (пустой - sample из индекса)',
			},
			max_results: {
				type: 'integer',
				description: `Лимит результатов (по умолчанию ${DEFAULT_MAX})`,
			},
			source: {
				type: 'string',
				enum: ['all', 'lsp', 'outline'],
				description: 'Источник: all (default) | lsp | outline (TS createSourceFile)',
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

		const query = asString(args, 'query', '').trim();
		const maxResults = Math.min(
			Math.max(1, asOptionalInt(args, 'max_results') ?? DEFAULT_MAX),
			AGENT_LIMITS.maxSearchMatches,
		);
		const sourceRaw = asString(args, 'source', 'all').trim().toLowerCase();
		const source = sourceRaw === 'lsp' || sourceRaw === 'outline' ? sourceRaw : 'all';

		try {
			const lspHits = source === 'outline' ? [] : await findInSymbolIndex(query, maxResults);
			const outlineHits = source === 'lsp' ? [] : await findInOutlineIndex(query, maxResults);

			return {
				ok: true,
				content: JSON.stringify(
					{
						query: query || null,
						source,
						lspCount: lspHits.length,
						outlineCount: outlineHits.length,
						hits: lspHits,
						outline: outlineHits,
					},
					null,
					2,
				),
			};
		} catch (err) {
			return {
				ok: false,
				content: err instanceof Error ? err.message : String(err),
			};
		}
	},
};
