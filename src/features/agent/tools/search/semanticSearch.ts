import * as vscode from 'vscode';
import { getSettings } from '../../../../core/config/settings';
import { semanticSearchWorkspace } from '../../../index/embeddings';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';

export const semanticSearchTool: ToolDefinition = {
	name: 'semantic_search',
	description: 'Семантический поиск: remote /embeddings с persistent cache, local vector index (mode=vector) или offline trigram fallback.',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
			},
			max_results: {
				type: 'integer',
			},
		},
		required: ['query'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const settings = getSettings();
		if (settings.indexingEnabled === false) {
			return {
				ok: false,
				content: 'semantic_search: индексирование отключено в настройках',
			};
		}

		if (settings.indexForGrep === false) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.indexForGrepOff'),
			};
		}

		const query = asString(args, 'query').trim();
		if (!query) {
			return {
				ok: false,
				content: 'semantic_search: нужен параметр query',
			};
		}

		try {
			const hits = await semanticSearchWorkspace(query, {
				maxResults: asOptionalInt(args, 'max_results') ?? 8,
				signal: ctx.signal,
			});
			return {
				ok: true,
				content: JSON.stringify(
					{
						query,
						localEmbeddingsMode: settings.localEmbeddingsMode,
						hits,
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

export const searchDocsTool: ToolDefinition = {
	name: 'search_docs',
	description: 'Поиск по документации проекта (папки docs/, Documentation/, *.md в корне) через semantic_search / текстовый fallback.',
	parameters: {
		type: 'object',
		properties: {
			query: { 
				type: 'string' 
			},
		},
		required: ['query'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const query = asString(args, 'query').trim();
		if (!query) {
			return { 
				ok: false, 
				content: 'search_docs: нужен параметр query' 
			};
		}

		try {
			const hits = await semanticSearchWorkspace(query, {
				maxFiles: 30,
				maxResults: 6,
				signal: ctx.signal,
			});
			const docs = hits.filter((h) => /(^|\/)(docs?|documentation)\//i.test(h.path) || /\.md$/i.test(h.path));
			return {
				ok: true,
				content: JSON.stringify({ 
					query, 
					hits: docs.length ? docs : hits 
				}, null, 2),
			};
		} catch (err) {
			return {
				ok: false,
				content: err instanceof Error ? err.message : String(err),
			};
		}
	},
};
