import * as vscode from 'vscode';
import { AGENT_LIMITS } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { relativeFromUri, throwIfAborted } from '../../workspacePath';

const FIND_EXCLUDE = '**/{.haratsan,node_modules,.git}/**';

const DEFAULT_GLOBS = [
	'**/*.log',
	'**/logs/**/*',
	'**/log/**/*',
	'**/*-debug.log',
	'**/npm-debug.log*',
	'**/yarn-error.log*',
];

export const findLogsTool: ToolDefinition = {
	name: 'find_logs',
	description: 'Найти файлы логов в workspace (*.log, logs/, log/). Для Debug Mode: сначала найди логи, потом read_log_tail.',
	parameters: {
		type: 'object',
		properties: {
			glob: {
				type: 'string',
				description: 'Доп. glob (например **/app*.log). Пусто - типичные шаблоны логов.',
			},
			max_results: {
				type: 'integer',
				description: 'Максимум путей',
			},
		},
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const cap = Math.min(
			Math.max(1, asOptionalInt(args, 'max_results') ?? AGENT_LIMITS.maxFindLogs),
			AGENT_LIMITS.maxFindLogs,
		);
		const extra = asString(args, 'glob').trim();
		const patterns = extra ? [extra, ...DEFAULT_GLOBS] : DEFAULT_GLOBS;
		const exclude = FIND_EXCLUDE;
		const seen = new Set<string>();
		const paths: string[] = [];

		for (const pattern of patterns) {
			throwIfAborted(ctx.signal);
			if (paths.length >= cap) {
				break;
			}

			let uris: vscode.Uri[];
			try {
				uris = await vscode.workspace.findFiles(pattern, exclude || '**/node_modules/**', cap * 2);
			} catch {
				continue;
			}

			for (const uri of uris) {
				if (paths.length >= cap) {
					break;
				}

				const relative = await relativeFromUri(uri);
				if (!relative || seen.has(relative)) {
					continue;
				}

				seen.add(relative);
				paths.push(relative);
			}
		}

		paths.sort((a, b) => a.localeCompare(b));
		return {
			ok: true,
			content: JSON.stringify({
				count: paths.length,
				paths,
				hint: paths.length === 0
					? vscode.l10n.t('tool.findLogsEmpty')
					: undefined,
			}, null, 2),
		};
	},
};
