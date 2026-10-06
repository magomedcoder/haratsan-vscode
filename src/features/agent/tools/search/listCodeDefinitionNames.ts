import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadOutlineIndex, type OutlineEntry } from '../../../index/tsOutline';
import { AGENT_LIMITS } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { resolveWorkspacePath, throwIfAborted } from '../../workspacePath';

const DEFAULT_MAX = 200;
const TOP_KINDS = new Set(['class', 'interface', 'type', 'enum', 'function', 'variable']);

function isTopLevel(entry: OutlineEntry): boolean {
	if (entry.containerName) {
		return false;
	}

	return TOP_KINDS.has(entry.kind) || entry.kind === 'method';
}

async function entriesForPath(
	relativeOrDir: string,
	folders: readonly vscode.WorkspaceFolder[],
): Promise<OutlineEntry[]> {
	const normalized = relativeOrDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
	const out: OutlineEntry[] = [];

	for (const folder of folders) {
		const doc = await loadOutlineIndex(folder.uri.fsPath);
		if (!doc?.entries.length) {
			continue;
		}

		for (const e of doc.entries) {
			const p = e.path.replace(/\\/g, '/');
			if (!normalized) {
				if (isTopLevel(e)) {
					out.push(e);
				}
				continue;
			}

			if (p === normalized || p.startsWith(`${normalized}/`)) {
				if (isTopLevel(e)) {
					out.push(e);
				}
			}
		}
	}

	return out;
}

export const listCodeDefinitionNamesTool: ToolDefinition = {
	name: 'list_code_definition_names',
	description: 'Список top-level определений (классы, функции, типы...) для файла или каталога по outline-индексу (workspace storage). Удобно для обзора модуля перед правками.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Файл или каталог относительно workspace (пусто - sample по всем корням)',
			},
			max_results: {
				type: 'integer',
				description: `Лимит (по умолчанию ${DEFAULT_MAX})`,
			},
		},
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);

		const folders = vscode.workspace.workspaceFolders ?? [];
		if (!folders.length) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.indexNotInit'),
			};
		}

		const pathArg = asString(args, 'path', '').trim().replace(/\\/g, '/');
		const maxResults = Math.min(
			Math.max(1, asOptionalInt(args, 'max_results') ?? DEFAULT_MAX),
			AGENT_LIMITS.maxSearchMatches,
		);

		if (pathArg) {
			try {
				const resolved = await resolveWorkspacePath(pathArg);
				const rel = vscode.workspace.asRelativePath(resolved.uri, false).replace(/\\/g, '/');
				let isDir = false;
				try {
					const st = await vscode.workspace.fs.stat(resolved.uri);
					isDir = (st.type & vscode.FileType.Directory) !== 0;
				} catch {
					isDir = !path.extname(rel);
				}

				let entries = await entriesForPath(rel, folders);
				if (!isDir) {
					entries = entries.filter((e) => e.path.replace(/\\/g, '/') === rel);
				}

				const clipped = entries.slice(0, maxResults);
				return {
					ok: true,
					content: JSON.stringify(
						{
							path: rel,
							scope: isDir ? 'directory' : 'file',
							count: clipped.length,
							truncated: entries.length > clipped.length,
							definitions: clipped.map((e) => ({
								name: e.name,
								kind: e.kind,
								path: e.path,
								startLine: e.startLine,
								endLine: e.endLine,
							})),
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
		}

		const entries = (await entriesForPath('', folders)).slice(0, maxResults);
		return {
			ok: true,
			content: JSON.stringify(
				{
					path: null,
					scope: 'workspace',
					count: entries.length,
					definitions: entries.map((e) => ({
						name: e.name,
						kind: e.kind,
						path: e.path,
						startLine: e.startLine,
						endLine: e.endLine,
					})),
				},
				null,
				2,
			),
		};
	},
};
