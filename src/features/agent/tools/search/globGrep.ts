import * as vscode from 'vscode';
import { AGENT_LIMITS } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { resolveWorkspacePath, throwIfAborted } from '../../workspacePath';

const FIND_EXCLUDE = '**/{.haratsan,node_modules,.git}/**';

function toGlob(pattern: string): string {
	const trimmed = pattern.trim() || '**/*';
	if (/[*?\[]/.test(trimmed)) {
		return trimmed;
	}

	if (/\.[A-Za-z0-9]+$/.test(trimmed)) {
		return trimmed;
	}

	return trimmed.replace(/\/?$/, '/') + '**';
}

export const globTool: ToolDefinition = {
	name: 'glob',
	description: 'Найти файлы по glob внутри workspace (без чтения содержимого). Учитывает .gitignore / .haratsanignore.',
	parameters: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'Glob, например **/*.ts'
			},
			max_results: {
				type: 'integer'
			},
		},
		required: ['pattern'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const pattern = toGlob(asString(args, 'pattern', '**/*'));
		const cap = Math.min(Math.max(1, asOptionalInt(args, 'max_results') ?? AGENT_LIMITS.maxSearchFiles), AGENT_LIMITS.maxSearchFiles);
		const uris = await vscode.workspace.findFiles(pattern, FIND_EXCLUDE, cap + 1);
		const files: string[] = [];
		for (const uri of uris.slice(0, cap)) {
			throwIfAborted(ctx.signal);
			try {
				files.push((await resolveWorkspacePath(uri.fsPath)).relative);
			} catch {
				continue;
			}
		}
		return {
			ok: true,
			content: JSON.stringify({ 
				pattern, 
				truncated: uris.length > cap,
				files 
			}, null, 2),
		};
	},
};

export const grepTool: ToolDefinition = {
	name: 'grep',
	description: 'Поиск текста/regex по содержимому файлов в workspace. Для списка путей используй glob.',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Подстрока или простой паттерн'
			},
			glob: {
				type: 'string',
				description: 'Ограничить glob, по умолчанию **/*'
			},
			max_results: {
				type: 'integer'
			},
		},
		required: ['query'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const query = asString(args, 'query');
		if (!query) {
			return {
				ok: false,
				content: 'grep: нужен параметр query'
			};
		}

		const glob = toGlob(asString(args, 'glob', '**/*'));
		const cap = Math.min(Math.max(1, asOptionalInt(args, 'max_results') ?? AGENT_LIMITS.maxSearchMatches), AGENT_LIMITS.maxSearchMatches);
		const uris = await vscode.workspace.findFiles(glob, FIND_EXCLUDE, AGENT_LIMITS.maxSearchFiles);
		const matches: Array<{
			path: string
			line: number
			text: string
		}> = [];
		for (const uri of uris) {
			if (matches.length >= cap) {
				break;
			}

			throwIfAborted(ctx.signal);
			try {
				const resolved = await resolveWorkspacePath(uri.fsPath);
				const doc = await vscode.workspace.openTextDocument(uri);
				const text = doc.getText();
				if (text.length > AGENT_LIMITS.maxReadBytes) {
					continue;
				}

				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i += 1) {
					if (matches.length >= cap) {
						break;
					}

					if (lines[i]!.toLowerCase().includes(query.toLowerCase())) {
						matches.push({ 
							path: resolved.relative, 
							line: i + 1, 
							text: lines[i]!.slice(0, 240) 
						});
					}
				}
			} catch {
				continue;
			}
		}
		
		return {
			ok: true,
			content: JSON.stringify({ 
				query, 
				glob, 
				truncated: matches.length >= cap, 
				matches 
			}, null, 2),
		};
	},
};
