import * as vscode from 'vscode';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';

export const getWorkspaceInfoTool: ToolDefinition = {
	name: 'get_workspace_info',
	description: 'Возвращает сведения о текущем VSCode workspace: папки, имя, число открытых текстовых документов.',
	parameters: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		if (ctx.signal?.aborted) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.cancelled')
			};
		}

		const folders = vscode.workspace.workspaceFolders ?? [];
		const payload = {
			folderCount: folders.length,
			folders: folders.map((f) => ({
				name: f.name,
				path: f.uri.fsPath,
			})),
			name: vscode.workspace.name ?? null,
			openTextDocuments: vscode.workspace.textDocuments.filter((d) => !d.isUntitled).length,
		};

		return {
			ok: true,
			content: JSON.stringify(payload, null, 2),
		};
	},
};
