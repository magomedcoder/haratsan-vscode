import * as vscode from 'vscode';
import { getSettings } from '../../../../core/config/settings';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { resolveWorkspacePath, throwIfAborted } from '../../workspacePath';
import { confirmAlwaysOrSkip } from '../confirm';
import { runWebSearch } from '../webSearchBackends';

function scorePath(rel: string, query: string): number {
	const q = query.toLowerCase();
	const p = rel.toLowerCase();
	const base = p.split('/').pop() ?? p;
	if (base === q) {
		return 1000;
	}
	
	if (base.startsWith(q)) {
		return 800 - base.length;
	}

	if (base.includes(q)) {
		return 600 - base.length;
	}

	if (p.includes(q)) {
		return 400 - p.length;
	}

	let ti = 0;
	for (const ch of p) {
		if (ch === q[ti]) {
			ti += 1;
			if (ti >= q.length) {
				return 200 - p.length;
			}
		}
	}
	return -1;
}

export const fileSearchTool: ToolDefinition = {
	name: 'file_search',
	description: 'Fuzzy поиск файлов по имени/пути в workspace.',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string'
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
		const query = asString(args, 'query').trim();
		if (!query) {
			return {
				ok: false,
				content: 'file_search: нужен параметр query'
			};
		}
		const cap = Math.min(Math.max(1, asOptionalInt(args, 'max_results') ?? 20), 40);
		const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.haratsan}/**', 8000);
		const scored: Array<{ path: string; score: number }> = [];
		for (const uri of uris) {
			throwIfAborted(ctx.signal);
			try {
				const rel = (await resolveWorkspacePath(uri.fsPath)).relative;
				const score = scorePath(rel, query);
				if (score >= 0) {
					scored.push({
						path: rel,
						score
					});
				}
			} catch {
				continue;
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return {
			ok: true,
			content: JSON.stringify({ 
				query, 
				files: scored.slice(0, cap).map((s) => s.path) 
			}, null, 2),
		};
	},
};

export const webSearchTool: ToolDefinition = {
	name: 'web_search',
	description: 'Поиск в вебе (DuckDuckGo / Exa / Parallel / HTTP JSON). Для точной страницы используй fetch_page.',
	parameters: {
		type: 'object',
		properties: {
			query: { 
				type: 'string' 
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
		const settings = getSettings();
		if (settings.webSearchEnabled === false) {
			return {
				ok: false,
				denied: true,
				content: 'web_search отключён в настройках'
			};
		}

		const query = asString(args, 'query').trim();
		if (!query) {
			return {
				ok: false,
				content: 'web_search: нужен параметр query'
			};
		}
		
		const denied = await confirmAlwaysOrSkip(ctx, `Веб-поиск: ${query}`, query);
		if (denied) {
			return denied;
		}

		const cap = Math.min(Math.max(1, asOptionalInt(args, 'max_results') ?? 5), 8);
		try {
			const results = await runWebSearch(
				settings.webSearchBackend,
				query,
				cap,
				ctx.signal,
				settings,
			);
			return {
				ok: true,
				content: JSON.stringify({ 
					query,
					backend: settings.webSearchBackend, 
					results
				}, null, 2),
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				content: msg.startsWith('web_search:') ? msg : `web_search: ${msg}`,
			};
		}
	},
};
