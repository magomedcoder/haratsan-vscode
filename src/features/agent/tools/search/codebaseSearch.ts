import * as vscode from 'vscode';
import { getSettings } from '../../../../core/config/settings';
import { getIndexManager } from '../../../index/IndexManager';
import { getIndexRunStats } from '../../../index/indexStats';
import { AGENT_LIMITS } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';

export const codebaseSearchTool: ToolDefinition = {
	name: 'codebase_search',
	description: 'Поиск по проиндексированной кодовой базе (триграммы). Быстрее полного grep/glob по большому проекту. Индекс в VS Code workspace storage.',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Что искать: имя символа, фраза, путь, концепция',
			},
			max_results: {
				type: 'integer',
				description: 'Лимит фрагментов',
			},
			debug: {
				type: 'boolean',
				description: 'Включить merkle skip % / AST ratio в ответ',
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
				content: vscode.l10n.t('tool.queryRequired') 
			};
		}

		const settings = getSettings();
		if (settings.indexForGrep === false) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.indexForGrepOff'),
			};
		}

		const cap = Math.min(
			Math.max(1, asOptionalInt(args, 'max_results') ?? 15),
			AGENT_LIMITS.maxSearchMatches,
		);

		const manager = getIndexManager();
		if (!manager) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.indexNotInit'),
			};
		}

		const progress = manager.getProgress();
		if (progress.state === 'indexing') {
			return {
				ok: true,
				content: JSON.stringify({
					query,
					indexing: true,
					hits: [],
					hint: vscode.l10n.t('tool.indexBuilding'),
				}, null, 2),
			};
		}

		const hits = await manager.search(query, cap);
		const folderFs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const debug = args.debug === true;
		const stats = folderFs && debug ? getIndexRunStats(folderFs) : undefined;
		return {
			ok: true,
			content: JSON.stringify({
				query,
				indexState: progress.state,
				fileCount: progress.fileCount,
				chunkCount: progress.chunkCount,
				hits,
				...(stats
					? {
							indexDebug: {
								merkleSkipPct:
									stats.lastMerkle && stats.lastMerkle.filesTotal > 0
										? Math.round((100 * stats.lastMerkle.filesSkipped) / stats.lastMerkle.filesTotal)
										: undefined,
								chunksReuse: stats.lastMerkle?.chunksSkipped,
								chunksIndexed: stats.lastMerkle?.chunksIndexed,
								astFiles: stats.filesAstChunked,
								lineFiles: stats.filesLineChunked,
								outlineBySource: stats.outlineBySource,
							},
						}
					: {}),
			}, null, 2),
		};
	},
};
