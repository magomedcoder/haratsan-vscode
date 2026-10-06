import * as vscode from 'vscode';
import { AGENT_LIMITS } from '../../policy';
import { asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';
import { confirmAlwaysOrSkip, confirmOrSkip, shouldConfirmWrites } from '../confirm';
import { annotateHtmlWithSourceHints } from '../../../design/designVisual';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeUrl(raw: string): URL | undefined {
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

		return url;
	} catch {
		return undefined;
	}
}

function isLocalUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
}

function stripScripts(html: string): string {
	return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

export const fetchPageTool: ToolDefinition = {
	name: 'fetch_page',
	description: 'Скачать HTML/текст страницы по URL (http/https) для анализа UI. Localhost без лишнего confirm; внешние URL - с подтверждением. Не полноценный браузер: нет кликов и скриншотов.',
	parameters: {
		type: 'object',
		properties: {
			url: {
				type: 'string',
				description: 'URL страницы (предпочтительно localhost preview)',
			},
		},
		required: ['url'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const parsed = normalizeUrl(asString(args, 'url'));
		if (!parsed) {
			return {
				ok: false,
				content: vscode.l10n.t('tool.browserBadUrl'),
			};
		}

		const href = parsed.toString();
		const local = isLocalUrl(parsed);
		if (!local) {
			const denied = await confirmAlwaysOrSkip(
				ctx,
				vscode.l10n.t('agent.confirm.fetchPageRemote', href),
				href,
			);
			if (denied) {
				return denied;
			}
		} else if (shouldConfirmWrites()) {
			const denied = await confirmOrSkip(
				ctx,
				vscode.l10n.t('agent.confirm.fetchPage', href),
				href,
			);
			if (denied) {
				return denied;
			}
		}

		const controller = new AbortController();
		const onAbort = () => controller.abort();
		ctx.signal?.addEventListener('abort', onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), 20_000);

		try {
			const res = await fetch(href, {
				signal: controller.signal,
				redirect: 'follow',
				headers: {
					Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
					'User-Agent': 'Haratsan-VSCode-Agent/0.2',
				},
			});
			const buf = await res.arrayBuffer();
			const bytes = new Uint8Array(buf);
			let truncated = false;
			let slice = bytes;
			if (slice.byteLength > AGENT_LIMITS.maxFetchPageBytes) {
				slice = slice.slice(0, AGENT_LIMITS.maxFetchPageBytes);
				truncated = true;
			}

			const raw = new TextDecoder('utf-8', { fatal: false }).decode(slice);
			const contentType = res.headers.get('content-type') ?? '';
			const stripped = contentType.includes('html') ? stripScripts(raw) : raw;
			const annotated = contentType.includes('html')
				? annotateHtmlWithSourceHints(stripped, href)
				: { 
					html: stripped, 
					sourceMapHint: undefined, 
					note: undefined 
				};

			return {
				ok: res.ok,
				content: JSON.stringify({
					url: href,
					status: res.status,
					ok: res.ok,
					contentType,
					bytes: bytes.byteLength,
					truncated,
					local,
					sourceMapHint: annotated.sourceMapHint ?? null,
					designNote: annotated.note ?? null,
					body: annotated.html,
				}, null, 2),
			};
		} catch (err) {
			return {
				ok: false,
				content: vscode.l10n.t(
					'tool.fetchPageFailed',
					err instanceof Error ? err.message : String(err),
				),
			};
		} finally {
			clearTimeout(timer);
			ctx.signal?.removeEventListener('abort', onAbort);
		}
	},
};
