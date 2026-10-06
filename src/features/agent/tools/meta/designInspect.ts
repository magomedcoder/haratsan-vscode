import * as vscode from 'vscode';
import { AGENT_LIMITS } from '../../policy';
import { asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';
import { confirmAlwaysOrSkip, confirmOrSkip, shouldConfirmWrites } from '../confirm';
import { annotateHtmlWithSourceHints, extractSelectorOuterHtml, selectorSearchTokens, DESIGN_SIMPLE_BROWSER_NOTE } from '../../../design/designVisual';

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
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

async function fetchHtml(href: string, signal?: AbortSignal): Promise<{
	ok: boolean;
	status: number;
	body: string;
	contentType: string;
}> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener('abort', onAbort, { once: true });
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
		let slice = new Uint8Array(buf);
		if (slice.byteLength > AGENT_LIMITS.maxFetchPageBytes) {
			slice = slice.slice(0, AGENT_LIMITS.maxFetchPageBytes);
		}

		const raw = new TextDecoder('utf-8', { fatal: false }).decode(slice);
		const contentType = res.headers.get('content-type') ?? '';
		const body = contentType.includes('html') ? stripScripts(raw) : raw;
		return { 
			ok: res.ok, 
			status: res.status, 
			body, contentType 
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

async function guessSourceFiles(tokens: string[], signal?: AbortSignal): Promise<Array<{ path: string; line: number; snippet: string; token: string }>> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder || tokens.length === 0) {
		return [];
	}

	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '**/*.{ts,tsx,js,jsx,css,scss,html,vue,svelte}'),
		'**/{node_modules,.git,.haratsan,dist,out}/**',
		80,
	);

	const hits: Array<{ path: string; line: number; snippet: string; token: string }> = [];
	for (const uri of uris) {
		if (hits.length >= 12) {
			break;
		}

		throwIfAborted(signal);
		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			const text = doc.getText();
			if (text.length > AGENT_LIMITS.maxReadBytes) {
				continue;
			}

			const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
			const lines = text.split(/\r?\n/);
			for (const token of tokens) {
				const patterns = [
					`className`,
					`class=`,
					`id=`,
					`"${token}"`,
					`'${token}'`,
					`\`${token}\``,
					`.${token}`,
					`#${token}`,
				];
				for (let i = 0; i < lines.length; i += 1) {
					const line = lines[i]!;
					if (!line.includes(token)) {
						continue;
					}

					const useful = patterns.some((p) => line.includes(p)) || line.includes(token);
					if (!useful) {
						continue;
					}

					hits.push({
						path: rel,
						line: i + 1,
						snippet: line.trim().slice(0, 200),
						token,
					});
					if (hits.length >= 12) {
						return hits;
					}
					break;
				}
			}
		} catch {
			continue;
		}
	}
	return hits;
}

// Эвристический click-to-code lite: fetch страницы, extract outerHTML селектора, grep workspace по class/id.
export const designInspectTool: ToolDefinition = {
	name: 'design_inspect',
	description: 'Design Mode visual MVP: по URL + CSS selector скачать HTML (как fetch_page), вернуть outerHTML совпадения и угаданный исходник через grep className/id. Не полный click-to-code в браузере.',
	parameters: {
		type: 'object',
		properties: {
			url: {
				type: 'string',
				description: 'URL страницы (предпочтительно localhost preview)',
			},
			selector: {
				type: 'string',
				description: 'Простой CSS selector: #id, .class или tag',
			},
		},
		required: ['url', 'selector'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const parsed = normalizeUrl(asString(args, 'url'));
		if (!parsed) {
			return { 
				ok: false, 
				content: vscode.l10n.t('tool.browserBadUrl') 
			};
		}

		const selector = asString(args, 'selector').trim();
		if (!selector) {
			return { 
				ok: false, 
				content: 'design_inspect: нужен selector (#id | .class | tag)' 
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

		try {
			const page = await fetchHtml(href, ctx.signal);
			const annotated = annotateHtmlWithSourceHints(page.body, href);
			const extracted = extractSelectorOuterHtml(annotated.html, selector);
			const tokens = selectorSearchTokens(selector);
			const guessedFiles = await guessSourceFiles(tokens, ctx.signal);

			return {
				ok: page.ok && extracted.matched,
				content: JSON.stringify(
					{
						url: href,
						status: page.status,
						selector,
						matched: extracted.matched,
						matchedBy: extracted.matchedBy ?? null,
						outerHtml: extracted.outerHtml ?? null,
						sourceMapHint: annotated.sourceMapHint ?? null,
						guessedFiles,
						note: DESIGN_SIMPLE_BROWSER_NOTE,
					},
					null,
					2,
				),
			};
		} catch (err) {
			return {
				ok: false,
				content: vscode.l10n.t(
					'tool.fetchPageFailed',
					err instanceof Error ? err.message : String(err),
				),
			};
		}
	},
};
