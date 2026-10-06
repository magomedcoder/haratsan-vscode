import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { buildCodebaseContextPack, collectFileHit, collectFolderHits, packContext } from '../index/contextEngine';
import { semanticSearchWorkspace } from '../index/embeddings';
import { getProjectMap } from '../index/projectMap';
import { formatSymbolIndexSummary } from '../index/symbolIndex';
import { getSettings } from '../../core/config/settings';
import { loadProjectRulesAppendix } from '../project/projectRules';
import { collectReferenceHits, ensureReferenceCached, formatReferenceSourceBlock } from '../project/references';
import { ensureTerminalBufferListener, getTerminalBuffers } from './terminalBuffer';
import { getSessionPeek } from './sessionStore';
import type { ChatUiMessage } from './protocol';
import { combineRetrievalScore, MENTION_KIND_MAX_HITS, MENTION_KIND_TOKEN_QUOTAS, packMentionHitsToQuota, packPastMessagesToQuota, scoreQueryRelevance } from './mentionKindRetrieval';
import type { MentionRetrievalHit } from './mentionKindRetrieval';
export type MentionKind = 'file' | 'folder' | 'codebase' | 'code' | 'git' | 'branch_diff' | 'git_changes' | 'problems' | 'rules' | 'link' | 'docs' | 'agent' | 'terminals' | 'past' | 'alias' | 'ref' | 'map' | 'symbols';

export interface ParsedMention {
	kind: MentionKind;
	arg?: string;
	raw: string;
	start: number;
	end: number;
}

export interface MentionContextBlock {
	kind: string;
	text: string;
}

export interface ResolvedMentions {
	cleanText: string;
	mentions: ParsedMention[];
	contextText: string;
	labels: string[];
	/** Per-mention блоки для eviction по budget (тяжёлые kinds первыми) */
	blocks: MentionContextBlock[];
}

// codebase раньше code - иначе @codebase сматчится как @code + arg "base"
// git_changes раньше git ; problems - argless
// Args: backticks / "double" / 'single' (через пробел или :); без кавычек = [^\s@]+ (без пробелов)
const MENTION_RE =
	/@(file|folder|codebase|code|git-changes|git_changes|git|branch_diff|problems|rules|link|docs|agent|terminals|past|alias|ref|map|symbols)(?:\s+`([^`]+)`|\s+"([^"]+)"|\s+'([^']+)'|:`([^`]+)`|:"([^"]+)"|:'([^']+)'|:([^\s`"']+)|(?:\s+)([^\s@]+))?/gi;

// Kinds без аргумента: не глотать следующее слово как arg
const ARGLESS_MENTION_KINDS = new Set<MentionKind>(['code', 'git', 'branch_diff', 'git_changes', 'problems', 'rules', 'terminals', 'map']);

function stripOuterQuotes(value: string): string {
	const t = value.trim();
	if (t.length >= 2) {
		const a = t[0];
		const b = t[t.length - 1];
		if ((a === '`' && b === '`') || (a === '"' && b === '"') || (a === "'" && b === "'")) {
			return t.slice(1, -1).trim();
		}
	}

	return t;
}

// Обернуть путь в кавычки для insert @file / @folder, если есть пробелы
export function formatMentionPathArg(path: string): string {
	const p = path.trim();
	if (!/[\s@]/.test(p)) {
		return p;
	}

	if (!p.includes('"')) {
		return `"${p}"`;
	}

	if (!p.includes("'")) {
		return `'${p}'`;
	}

	return `\`${p.replace(/`/g, '')}\``;
}

function git(args: string[]): Promise<string> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (!folders.length) {
		return Promise.resolve('');
	}

	const tryFolder = (root: string): Promise<string> =>
		new Promise((resolve) => {
			const c = spawn('git', args, { cwd: root });
			let o = '';
			c.stdout.on('data', (d) => {
				o += String(d);
			});
			c.on('error', () => resolve(''));
			c.on('close', (code) => resolve(code === 0 || o.trim() ? o.trim() : ''));
		});

	return (async () => {
		for (const folder of folders) {
			const out = await tryFolder(folder.uri.fsPath);
			if (out) {
				return out;
			}
		}
		return '';
	})();
}

const DIAG_SEVERITY: Record<number, string> = {
	[vscode.DiagnosticSeverity.Error]: 'error',
	[vscode.DiagnosticSeverity.Warning]: 'warning',
	[vscode.DiagnosticSeverity.Information]: 'info',
	[vscode.DiagnosticSeverity.Hint]: 'hint',
};

async function resolveProblemsContext(): Promise<string> {
	const cap = 80;
	const items: string[] = [];
	let total = 0;
	for (const [uri, diags] of vscode.languages.getDiagnostics()) {
		const file = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
		for (const diag of diags) {
			total += 1;
			if (items.length >= cap) {
				continue;
			}

			const sev = DIAG_SEVERITY[diag.severity] ?? String(diag.severity);
			items.push(
				`${sev} ${file}:${diag.range.start.line + 1}:${diag.range.start.character + 1} ${diag.source ? `[${diag.source}] ` : ''}${diag.message}`,
			);
		}
	}

	if (!items.length) {
		return '[problems] нет диагностик';
	}

	const more = total > items.length ? `\n... +${total - items.length} ещё` : '';
	return `[problems ${items.length}/${total}]\n${items.join('\n')}${more}`.slice(0, 12_000);
}

async function resolveGitChangesContext(): Promise<string> {
	const status = await git(['status', '-sb']);
	const unstaged = await git(['diff', '--stat']);
	const unstagedPatch = await git(['diff', '--', '.']);
	const staged = await git(['diff', '--cached', '--stat']);
	const stagedPatch = await git(['diff', '--cached', '--', '.']);
	const parts = [
		status && `status:\n${status}`,
		staged && `staged (--cached):\n${staged}`,
		stagedPatch && `staged patch:\n${stagedPatch.slice(0, 6_000)}`,
		unstaged && `unstaged:\n${unstaged}`,
		unstagedPatch && `unstaged patch:\n${unstagedPatch.slice(0, 6_000)}`,
	].filter(Boolean);
	if (!parts.length) {
		return '[git-changes] нет изменений или не git-репозиторий';
	}

	return `[git-changes]\n${parts.join('\n\n')}`.slice(0, 14_000);
}

function slugifyAgentName(name: string): string {
	return name.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9_-]/g, '')
		.slice(0, 48);
}

// Выделение или символ рядом с курсором -> блок контекста
async function resolveCodeContext(): Promise<string> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return '[code] нет активного редактора';
	}

	const doc = editor.document;
	const relative = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
	const maxChars = getSettings().maxInputChars;
	const sel = editor.selection;

	if (!sel.isEmpty) {
		const text = doc.getText(sel);
		const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n...` : text;
		const start = sel.start.line + 1;
		const end = sel.end.line + 1;
		return `[code selection ${relative}:${start}-${end}]\n${clipped}`;
	}

	const pos = sel.active;
	const wordRange = doc.getWordRangeAtPosition(pos);
	const symbolName = wordRange ? doc.getText(wordRange) : '';

	try {
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
		if (symbols?.length) {
			const flat: vscode.DocumentSymbol[] = [];
			const walk = (items: vscode.DocumentSymbol[]) => {
				for (const s of items) {
					flat.push(s);
					if (s.children?.length) {
						walk(s.children);
					}
				}
			};
			walk(symbols);
			const enclosing = flat.filter((s) => s.range.contains(pos)).sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line))[0];
			if (enclosing) {
				const body = doc.getText(enclosing.range);
				const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n...` : body;
				return `[code symbol ${relative} ${enclosing.name} (${enclosing.range.start.line + 1}-${enclosing.range.end.line + 1})]\n${clipped}`;
			}
		}
	} catch {}

	const startLine = Math.max(0, pos.line - 8);
	const endLine = Math.min(doc.lineCount - 1, pos.line + 24);
	const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
	const body = doc.getText(range);
	const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n...` : body;
	const label = symbolName ? `near «${symbolName}»` : 'cursor';
	return `[code ${label} ${relative}:${startLine + 1}-${endLine + 1}]\n${clipped}`;
}

// Поиск по docs/ и markdown: rank по query + per-kind token quota
async function resolveDocsContext(query: string): Promise<string> {
	const q = query.trim() || 'docs';
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return '[Docs] нет workspace';
	}

	const empty = `[Docs] ничего не найдено по запросу «${q}»`;
	const toPack = (hits: MentionRetrievalHit[]) => {
		const packed = packMentionHitsToQuota(hits, 'docs', {
			kindTag: 'Docs',
			emptyMessage: empty,
		});
		return packed.text || empty;
	};

	try {
		const hits = await semanticSearchWorkspace(q, {
			maxFiles: 30,
			maxResults: MENTION_KIND_MAX_HITS.docs,
		});
		const docs = hits.filter((h) => /(^|\/)(docs?|documentation)\//i.test(h.path) || /\.md$/i.test(h.path));
		const picked = docs.length ? docs : hits;
		if (picked.length) {
			const ranked: MentionRetrievalHit[] = picked.map((h) => {
				const snip = (h.snippet ?? '').slice(0, 1600);
				const inDocs = /(^|\/)(docs?|documentation)\//i.test(h.path) ? 0.08 : 0;
				return {
					path: h.path,
					snippet: snip,
					score: Math.min(1, combineRetrievalScore(h.score, h.path, snip, q) + inDocs),
				};
			});
			return toPack(ranked);
		}
	} catch {}

	const patterns = ['docs/**/*.md', 'Documentation/**/*.md', 'doc/**/*.md', '*.md'];
	const candidates: MentionRetrievalHit[] = [];
	const seen = new Set<string>();
	const needle = q.toLowerCase();

	for (const pattern of patterns) {
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, pattern),
			'**/{.haratsan,node_modules,.git}/**',
			24,
		);

		for (const uri of uris) {
			const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
			if (seen.has(relative)) {
				continue;
			}

			try {
				const raw = await vscode.workspace.fs.readFile(uri);
				const text = new TextDecoder('utf8', { fatal: false }).decode(raw);
				const snip = text.slice(0, 2000);
				const pathHit = needle && needle !== 'docs' && relative.toLowerCase().includes(needle);
				const bodyHit = needle && needle !== 'docs' && text.toLowerCase().includes(needle);
				if (needle && needle !== 'docs' && !pathHit && !bodyHit) {
					continue;
				}

				seen.add(relative);
				const inDocs = /(^|\/)(docs?|documentation)\//i.test(relative) ? 0.1 : 0;
				candidates.push({
					path: relative,
					snippet: snip,
					score: Math.min(1, scoreQueryRelevance(`${relative}\n${snip}`, q) + inDocs + (pathHit ? 0.15 : 0)),
				});
			} catch {
				continue;
			}

			if (candidates.length >= MENTION_KIND_MAX_HITS.docs * 2) {
				break;
			}
		}

		if (candidates.length >= MENTION_KIND_MAX_HITS.docs * 2) {
			break;
		}
	}

	return candidates.length ? toPack(candidates) : empty;
}

// Тело `.haratsan/agents/{name}.md` в контекст
async function resolveAgentContext(name: string | undefined): Promise<string> {
	if (!name?.trim()) {
		return '[agent] укажи имя: @agent name';
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return '[agent] нет workspace';
	}

	const rawName = name.trim();
	const slug = slugifyAgentName(rawName);
	const candidates = [
		`${rawName}.md`,
		`${slug}.md`,
		`${rawName.toLowerCase()}.md`,
	];
	const seen = new Set<string>();

	for (const file of candidates) {
		if (seen.has(file)) {
			continue;
		}

		seen.add(file);
		const uri = vscode.Uri.joinPath(folder.uri, '.haratsan', 'agents', file);
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			let text = new TextDecoder('utf8', { fatal: false }).decode(bytes);
			const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(text.trim());
			if (fm) {
				text = fm[1]!.trim();
			}

			const clipped = text.length > 12_000 ? `${text.slice(0, 12_000)}\n\n[truncated]` : text;
			const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
			return `[agent ${rawName} -> ${relative}]\n${clipped}`;
		} catch {
			continue;
		}
	}

	// Поиск по glob, если точное имя не совпало
	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '.haratsan/agents/*.md'),
		undefined,
		40,
	);

	const needle = slug || rawName.toLowerCase();
	for (const uri of uris) {
		const base = (uri.path.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase();
		if (base === needle || base.includes(needle)) {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				let text = new TextDecoder('utf8', { fatal: false }).decode(bytes);
				const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(text.trim());
				if (fm) {
					text = fm[1]!.trim();
				}

				const clipped = text.length > 12_000 ? `${text.slice(0, 12_000)}\n\n[truncated]` : text;
				const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
				return `[agent ${rawName} -> ${relative}]\n${clipped}`;
			} catch {
				continue;
			}
		}
	}

	return `[agent] файл .haratsan/agents/${slug || rawName}.md не найден`;
}

// Хвосты терминалов: rank по query (cleanText) + token quota
function resolveTerminalsContext(query?: string): string {
	ensureTerminalBufferListener();
	const perCap = Math.min(4_000, getSettings().maxInputChars);
	const terminals = getTerminalBuffers();
	if (terminals.length === 0) {
		return '[terminals] нет открытых терминалов';
	}

	const q = query?.trim() ?? '';
	const hits: MentionRetrievalHit[] = terminals.map((t, i) => {
		const meta = [
			t.lastCommand ? `cmd: ${t.lastCommand}` : undefined,
			typeof t.exitCode === 'number' ? `exit: ${t.exitCode}` : undefined,
		].filter(Boolean).join('; ');
		const bodyCore = t.text.trim()
			? (t.text.length > perCap ? `${t.text.slice(-perCap)}\n...` : t.text)
			: '(нет буферизованного вывода - выполни команду в терминале)';
		const body = meta ? `${meta}\n${bodyCore}` : bodyCore;
		const lexical = scoreQueryRelevance(`${t.name}\n${body}`, q);
		const hasOutput = t.text.trim() ? 0.12 : 0;
		const failedBoost = typeof t.exitCode === 'number' && t.exitCode !== 0 ? 0.15 : 0;
		// Без query - чуть предпочитаем терминалы с выводом / ошибкой; иначе lexical
		const score = q
			? Math.min(1, lexical + hasOutput + failedBoost)
			: Math.min(1, hasOutput + failedBoost + (terminals.length - i) * 0.01);
		return {
			path: t.name,
			header: t.name,
			snippet: body,
			score,
		};
	});

	const packed = packMentionHitsToQuota(hits, 'terminals', {
		kindTag: 'terminal',
		maxTokens: MENTION_KIND_TOKEN_QUOTAS.terminals,
	});
	return packed.text || '[terminals] нет открытых терминалов';
}

function lastUserSnippet(messages: ChatUiMessage[], maxLen = 120): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i]!;
		if (m.role === 'user' && m.content.trim()) {
			const line = m.content.trim().replace(/\s+/g, ' ');
			return line.length > maxLen ? `${line.slice(0, maxLen - 1)}...` : line;
		}
	}

	return '';
}

// Прошлые чаты: rank сессий / сообщений по query + token quota
function resolvePastChat(arg?: string, query?: string): string {
	const store = getSessionPeek();
	if (!store) {
		return '[past] нет доступа к сессиям';
	}

	const needle = arg?.trim();
	const rankQuery = (query?.trim() || needle || '').trim();
	const currentId = store.getCurrentSessionId();

	if (needle) {
		const lower = needle.toLowerCase();
		const summaries = store.listSessions();
		const byId = summaries.find((s) => s.id === needle);
		const byExactTitle = summaries.find((s) => s.title.toLowerCase() === lower);
		const bySub = summaries.find((s) => s.title.toLowerCase().includes(lower));
		const hit = byId ?? byExactTitle ?? bySub;
		if (!hit) {
			return `[past] сессия «${needle}» не найдена`;
		}

		const session = store.getSession(hit.id);
		if (!session) {
			return `[past] сессия «${hit.title}» не найдена`;
		}

		const packed = packPastMessagesToQuota(session.messages, rankQuery, {
			sessionTitle: session.title,
			maxTokens: MENTION_KIND_TOKEN_QUOTAS.past,
		});
		if (!packed.kept.length) {
			return `[past ${session.title}]\n(нет сообщений)`;
		}

		return packed.text;
	}

	// Без arg - ранжированный список недавних сессий (без текущей)
	const recent = store.listSessions().filter((s) => s.id !== currentId);
	if (recent.length === 0) {
		return '[past] нет других сохранённых чатов';
	}

	const hits: MentionRetrievalHit[] = recent.map((s, i) => {
		const session = store.getSession(s.id);
		const snip = session ? lastUserSnippet(session.messages) : '';
		const line = snip ? `${s.title} - ${snip}` : s.title;
		const recency = (recent.length - i) / Math.max(1, recent.length);
		const lexical = scoreQueryRelevance(`${s.title}\n${snip}`, rankQuery);
		return {
			path: s.id,
			header: s.title,
			snippet: line,
			score: Math.min(1, lexical * 0.7 + recency * 0.3),
		};
	});

	const packed = packMentionHitsToQuota(hits, 'past', {
		kindTag: 'past',
		emptyMessage: '[past] нет других сохранённых чатов',
	});
	if (!packed.kept.length) {
		return '[past] нет других сохранённых чатов';
	}

	const lines = packed.kept.map((h) => `- ${h.snippet}`);
	const note = packed.truncated ? `\n[truncated past list  quota ${packed.maxTokens} tok]` : '';
	return `[past chats]\n${lines.join('\n')}${note}`;
}

export function parseMentions(text: string): ParsedMention[] {
	const out: ParsedMention[] = [];
	for (const match of text.matchAll(MENTION_RE)) {
		let kind = match[1]!.toLowerCase() as MentionKind | 'git-changes';
		if (kind === 'git-changes') {
			kind = 'git_changes';
		}
		const rawMatch = match[0];
		const start = match.index ?? 0;
		// группы: ` / " / ' (пробел), затем ` / " / ' (:), затем :без_кавычек / пробел-без_кавычек
		let arg = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9] ?? '').trim() || undefined;
		let end = start + rawMatch.length;

		// kinds без arg: не съедать следующее слово (`@terminals что` * только @terminals)
		const explicitlyQuoted = /[`"']/.test(rawMatch) || rawMatch.includes(':');
		if (ARGLESS_MENTION_KINDS.has(kind) && arg && !explicitlyQuoted) {
			const kindOnly = kind === 'git_changes' ? '@git-changes' : `@${kind}`;
			arg = undefined;
			end = start + kindOnly.length;
			out.push({
				kind,
				arg,
				raw: text.slice(start, end),
				start,
				end,
			});
			continue;
		}

		if (arg) {
			arg = stripOuterQuotes(arg) || undefined;
		}

		out.push({
			kind,
			arg,
			raw: rawMatch,
			start,
			end,
		});
	}

	return out;
}

export function stripMentions(text: string, mentions: readonly ParsedMention[]): string {
	if (mentions.length === 0) {
		return text.trim();
	}

	let result = text;
	for (let i = mentions.length - 1; i >= 0; i -= 1) {
		const m = mentions[i]!;
		result = result.slice(0, m.start) + result.slice(m.end);
	}

	return result.replace(/\s+/g, ' ').trim();
}

export async function resolveMentions(text: string): Promise<ResolvedMentions> {
	const mentions = parseMentions(text);
	if (mentions.length === 0) {
		return {
			cleanText: text.trim(),
			mentions: [],
			contextText: '',
			labels: [],
			blocks: [],
		};
	}

	const cleanText = stripMentions(text, mentions);
	const labels: string[] = [];
	const blocks: MentionContextBlock[] = [];

	const pushBlock = (kind: string, text: string | undefined) => {
		const trimmed = text?.trim();
		if (!trimmed) {
			return;
		}
		blocks.push({ kind, text: trimmed });
	};

	for (const mention of mentions) {
		if (mention.kind === 'file') {
			if (!mention.arg) {
				labels.push('@file(?)');
				continue;
			}

			const label = `@file ${mention.arg}`;
			labels.push(label);
			const hit = await collectFileHit(mention.arg.replace(/\\/g, '/'));
			if (hit) {
				pushBlock(label, packContext([hit], 24_000).text);
			}

			continue;
		}

		if (mention.kind === 'folder') {
			if (!mention.arg) {
				labels.push('@folder(?)');
				continue;
			}

			const label = `@folder ${mention.arg}`;
			labels.push(label);
			const folderHits = await collectFolderHits(mention.arg.replace(/\\/g, '/'));
			pushBlock(label, packContext(folderHits, 24_000).text);
			continue;
		}

		if (mention.kind === 'codebase') {
			const label = mention.arg ? `@codebase ${mention.arg}` : '@codebase';
			labels.push(label);
			const pack = await buildCodebaseContextPack(mention.arg ?? (cleanText || 'project'));
			pushBlock(label, pack.text);
			continue;
		}

		if (mention.kind === 'map') {
			labels.push('@map');
			try {
				const map = await getProjectMap();
				pushBlock('@map', `[map]\n${map.outline}`.slice(0, 12_000));
			} catch (err) {
				pushBlock('@map', `[map] ${err instanceof Error ? err.message : String(err)}`);
			}
			continue;
		}

		if (mention.kind === 'symbols') {
			const label = mention.arg ? `@symbols ${mention.arg}` : '@symbols';
			labels.push(label);
			pushBlock(label, await formatSymbolIndexSummary(mention.arg ?? (cleanText || undefined)));
			continue;
		}

		if (mention.kind === 'code') {
			labels.push('@code');
			pushBlock('@code', await resolveCodeContext());
			continue;
		}

		if (mention.kind === 'docs') {
			const label = mention.arg ? `@Docs ${mention.arg}` : '@Docs';
			labels.push(label);
			pushBlock(label, await resolveDocsContext(mention.arg ?? cleanText));
			continue;
		}

		if (mention.kind === 'agent') {
			const label = mention.arg ? `@agent ${mention.arg}` : '@agent(?)';
			labels.push(label);
			pushBlock(label, await resolveAgentContext(mention.arg));
			continue;
		}

		if (mention.kind === 'git') {
			const sha = mention.arg?.trim();
			const label = sha ? `@git ${sha}` : '@git';
			labels.push(label);
			const log = sha
				? await git(['show', '--stat', '--oneline', '-s', sha])
				: await git(['log', '-5', '--oneline']);
			if (log) {
				pushBlock(label, `[git]\n${log.slice(0, 4000)}`);
			}

			continue;
		}

		if (mention.kind === 'branch_diff') {
			labels.push('@branch_diff');
			const diff = await git(['diff', '--stat', 'HEAD']);
			const status = await git(['status', '-sb']);
			pushBlock('@branch_diff', `[branch_diff]\n${status}\n${diff}`.slice(0, 6000));
			continue;
		}

		if (mention.kind === 'git_changes') {
			labels.push('@git-changes');
			pushBlock('@git-changes', await resolveGitChangesContext());
			continue;
		}

		if (mention.kind === 'problems') {
			labels.push('@problems');
			pushBlock('@problems', await resolveProblemsContext());
			continue;
		}

		if (mention.kind === 'rules') {
			labels.push('@rules');
			const rules = await loadProjectRulesAppendix();
			pushBlock('@rules', rules);
			continue;
		}

		if (mention.kind === 'link') {
			const url = mention.arg?.trim();
			const label = url ? `@link ${url}` : '@link(?)';
			labels.push(label);
			if (url) {
				try {
					const res = await fetch(url.startsWith('http') ? url : `https://${url}`, {
						signal: AbortSignal.timeout(10_000),
					});
					const body = (await res.text()).slice(0, 8000);
					pushBlock(label, `[link ${url}]\n${body}`);
				} catch (err) {
					pushBlock(label, `[link ${url}] error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			continue;
		}

		if (mention.kind === 'terminals') {
			labels.push('@terminals');
			// cleanText - query для rank (kind без arg)
			pushBlock('@terminals', resolveTerminalsContext(cleanText));
			continue;
		}

		if (mention.kind === 'past') {
			const label = mention.arg ? `@past ${mention.arg}` : '@past';
			labels.push(label);
			pushBlock(label, resolvePastChat(mention.arg, cleanText));
			continue;
		}

		if (mention.kind === 'alias' || mention.kind === 'ref') {
			const name = mention.arg?.trim();
			const tag = mention.kind === 'ref' ? '@ref' : '@alias';
			const label = name ? `${tag} ${name}` : `${tag}(?)`;
			labels.push(label);
			if (!name) {
				pushBlock(label, `[alias] укажи имя: @alias name или @ref:name`);
				continue;
			}

			const resolved = await ensureReferenceCached(name);
			if ('error' in resolved) {
				pushBlock(label, `[alias ${name}] ${resolved.error}`);
				continue;
			}

			const refParts = [
				formatReferenceSourceBlock(resolved),
				packContext(await collectReferenceHits(resolved), 24_000).text,
			].filter(Boolean);
			pushBlock(label, refParts.join('\n\n'));
		}
	}

	const contextText = blocks.map((b) => b.text).filter(Boolean).join('\n\n');

	return {
		cleanText,
		mentions,
		contextText,
		labels,
		blocks,
	};
}
