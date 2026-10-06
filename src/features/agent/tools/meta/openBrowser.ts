import * as vscode from 'vscode';
import { asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';
import { confirmOrSkip, shouldConfirmWrites } from '../confirm';

function normalizeUrl(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}

	try {
		const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `http://${trimmed}`;
		const url = new URL(withScheme);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return undefined;
		}

		return url.toString();
	} catch {
		return undefined;
	}
}

export const openBrowserTool: ToolDefinition = {
	name: 'open_browser',
	description: 'Открыть URL во встроенном Simple Browser VSCode. Для Design Mode: показать UI пользователю.',
	parameters: {
		type: 'object',
		properties: {
			url: {
				type: 'string',
				description: 'URL (http/https), например http://localhost:3000',
			},
		},
		required: ['url'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const url = normalizeUrl(asString(args, 'url'));
		if (!url) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.browserBadUrl'),
			};
		}

		if (shouldConfirmWrites()) {
			const denied = await confirmOrSkip(ctx, vscode.l10n.t('agent.confirm.openBrowser', url), url);
			if (denied) {
				return denied;
			}
		}

		try {
			await vscode.commands.executeCommand('simpleBrowser.show', url);
		} catch (err) {
			return {
				ok: false,
				content: vscode.l10n.t(
					'tool.browserOpenFailed',
					err instanceof Error ? err.message : String(err),
				),
			};
		}

		return {
			ok: true,
			content: vscode.l10n.t('tool.browserOpened', url),
		};
	},
};
