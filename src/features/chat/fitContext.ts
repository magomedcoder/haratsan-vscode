import type { HaratsanSettings } from '../../core/config/types';
import { getCachedNCtx, getEffectiveContextBudget, isNearContextBudget, isOverContextBudget, setCachedNCtx } from '../../core/llm/contextBudget';
import { ContextBudgetExceededError, formatContextOverflowUserMessage, parseContextOverflow } from '../../core/llm/contextOverflow';
import type { ContextOverflowInfo } from '../../core/llm/contextOverflow';
import { estimateChatMessagesTokens } from '../../core/llm/estimateTokens';
import type { ChatContentPart, ChatMessage, CompleteResult, LlmClient } from '../../core/llm/types';
import * as vscode from 'vscode';

export const MAX_CONTEXT_OVERFLOW_RETRIES = 1;

// Сколько последних tool-сообщений оставлять с обычным cap (остальные -> digest)
export const DEFAULT_RECENT_TOOL_KEEP = 4;

const TOOL_DIGEST_PREVIEW_CHARS = 80;
const KEEP_TAIL_MESSAGES = 8;

// Известные префиксы compact-summary (EN/RU l10n)
const COMPACT_SUMMARY_MARKERS = [
	'[Summary of earlier conversation]',
	'[Сводка более ранней переписки]',
];

// Напоминания Plan<->Agent - оставляем только последнее
const MODE_REMINDER_MARKERS = [
	'Режим Plan включён.',
	'Режим Agent включён.',
];

const MID_LOOP_COMPACT_MARKER = '[mid-loop compact]';

export interface ShrinkStats {
	prunedChars: number;
	prunedMessages: number;
}

export interface ShrinkResult extends ShrinkStats {
	messages: ChatMessage[];
	changed: boolean;
}

function emptyShrinkStats(): ShrinkStats {
	return { 
		prunedChars: 0, 
		prunedMessages: 0 
	};
}

function addStats(a: ShrinkStats, b: ShrinkStats): ShrinkStats {
	return {
		prunedChars: a.prunedChars + b.prunedChars,
		prunedMessages: a.prunedMessages + b.prunedMessages,
	};
}

function contentLength(content: string | ChatContentPart[] | null | undefined): number {
	if (content === null || content === undefined) {
		return 0;
	}

	if (typeof content === 'string') {
		return content.length;
	}

	return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0);
}

function messageText(msg: ChatMessage): string {
	if (msg.role === 'tool') {
		return msg.content;
	}

	const c = msg.content;
	if (typeof c === 'string') {
		return c;
	}

	if (Array.isArray(c)) {
		return c.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n');
	}

	return '';
}

function startsWithAny(text: string, markers: readonly string[]): boolean {
	const t = text.trimStart();
	return markers.some((m) => t.startsWith(m));
}

/**
 * Убрать устаревшие compact/mode reminders из API-истории.
 * Оставляет только последнее сообщение каждого типа.
 */
export function dropSupersededReminders(messages: readonly ChatMessage[]): ShrinkResult {
	const current = cloneMessages(messages);
	const dropIdx = new Set<number>();

	const markOlder = (markers: readonly string[]): void => {
		let last = -1;
		for (let i = 0; i < current.length; i += 1) {
			const msg = current[i]!;
			if (msg.role !== 'assistant' && msg.role !== 'user') {
				continue;
			}

			if (startsWithAny(messageText(msg), markers)) {
				if (last >= 0) {
					dropIdx.add(last);
				}
				last = i;
			}
		}
	};

	markOlder(COMPACT_SUMMARY_MARKERS);
	markOlder(MODE_REMINDER_MARKERS);

	if (dropIdx.size === 0) {
		return { messages: current, changed: false, ...emptyShrinkStats() };
	}

	let prunedChars = 0;
	const next: ChatMessage[] = [];
	for (let i = 0; i < current.length; i += 1) {
		if (dropIdx.has(i)) {
			prunedChars += contentLength(current[i]!.role === 'tool' ? current[i]!.content : (current[i] as { content?: string | ChatContentPart[] | null }).content);
			continue;
		}
		next.push(current[i]!);
	}

	return {
		messages: next,
		changed: true,
		prunedChars,
		prunedMessages: dropIdx.size,
	};
}

// Опциональные reasoning-поля, которые провайдер мог положить в apiMessages
type AssistantThoughtFields = {
	thinking?: string;
	reasoning_content?: string;
	reasoning?: string;
};

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	return `${text.slice(0, Math.max(0, maxChars - 32))}\n...[truncated ${text.length - maxChars} chars]`;
}

function truncateContent(
	content: string | ChatContentPart[] | null,
	maxChars: number,
): string | ChatContentPart[] | null {
	if (content === null || content === undefined) {
		return content;
	}

	if (typeof content === 'string') {
		return truncateText(content, maxChars);
	}

	return content.map((part) => {
		if (part.type === 'text') {
			return {
				type: 'text' as const,
				text: truncateText(part.text, maxChars)
			};
		}

		return part;
	});
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
	return messages.map((m) => {
		if (m.role === 'assistant') {
			const thoughts = m as ChatMessage & AssistantThoughtFields;
			return {
				role: 'assistant',
				content: m.content,
				...(m.tool_calls ? {
					tool_calls: m.tool_calls.map((c) => ({
						...c, function: {
							...c.function
						}
					}))
				} : {}),
				...(thoughts.thinking ? { 
					thinking: thoughts.thinking 
				} : {}),
				...(thoughts.reasoning_content ? { 
					reasoning_content: thoughts.reasoning_content 
				} : {}),
				...(typeof thoughts.reasoning === 'string' && thoughts.reasoning
					? { 
						reasoning: thoughts.reasoning 
					}
					: {}),
			} as ChatMessage;
		}

		if (m.role === 'tool') {
			return { ...m };
		}

		return {
			role: m.role,
			content: m.content
		} as ChatMessage;
	});
}

// N последних tool: compactTailTurns (default 4), иначе DEFAULT_RECENT_TOOL_KEEP
export function recentToolKeepCount(settings: HaratsanSettings): number {
	const n = settings.compactTailTurns;
	if (typeof n === 'number' && Number.isFinite(n) && n >= 1) {
		return Math.min(40, Math.max(1, Math.floor(n)));
	}

	return DEFAULT_RECENT_TOOL_KEEP;
}

// Короткий digest вместо полного tool body
export function pruneToolToDigest(content: string): string {
	const raw = content ?? '';
	if (raw.startsWith('[pruned tool result]')) {
		return raw;
	}

	const n = raw.length;
	if (n <= TOOL_DIGEST_PREVIEW_CHARS + 40) {
		return raw;
	}

	const preview = raw.slice(0, TOOL_DIGEST_PREVIEW_CHARS).replace(/\s+/g, ' ').trimEnd();
	return `${preview}...\n[pruned tool result] (was ${n} chars; compacted)`;
}

// Digest со ссылкой на более ранний тот же tool/path
export function pruneToolToEarlierRef(content: string, earlierToolCallId: string): string {
	const n = content.length;
	const preview = content.slice(0, Math.min(40, n)).replace(/\s+/g, ' ').trimEnd();
	return `${preview}${n > 40 ? '...' : ''}\n[duplicate tool result -> earlier #${earlierToolCallId}] (was ${n} chars)`;
}

const SCRATCH_EPHEMERAL_TOOLS = new Set(['run_scratch', 'register_ephemeral_tool']);

/**
 * Scratch / ephemeral noise: в API только последний релевантный output
 * для run_scratch / register_ephemeral_tool; более старые -> digest.
 */
export function pruneScratchEphemeralNoise(messages: readonly ChatMessage[]): ShrinkResult {
	const current = cloneMessages(messages);
	const nameById = buildToolCallNameMap(current);
	const idxs: number[] = [];
	for (let i = 0; i < current.length; i += 1) {
		const msg = current[i]!;
		if (msg.role !== 'tool') {
			continue;
		}

		const name = (msg.name ?? nameById.get(msg.tool_call_id) ?? '').toLowerCase();
		if (SCRATCH_EPHEMERAL_TOOLS.has(name)) {
			idxs.push(i);
		}
	}

	if (idxs.length <= 1) {
		return { messages: current, changed: false, ...emptyShrinkStats() };
	}

	let changed = false;
	let prunedChars = 0;
	let prunedMessages = 0;
	const keep = idxs[idxs.length - 1]!;
	for (const i of idxs) {
		if (i === keep) {
			continue;
		}

		const msg = current[i]!;
		if (msg.role !== 'tool') {
			continue;
		}

		const next = pruneToolToDigest(msg.content);
		if (next !== msg.content) {
			prunedChars += Math.max(0, msg.content.length - next.length);
			prunedMessages += 1;
			current[i] = { ...msg, content: next };
			changed = true;
		}
	}

	return { messages: current, changed, prunedChars, prunedMessages };
}

function toolMessageIndices(messages: readonly ChatMessage[]): number[] {
	const idxs: number[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		if (messages[i]!.role === 'tool') {
			idxs.push(i);
		}
	}

	return idxs;
}

function findLastUserIndex(messages: readonly ChatMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]!.role === 'user') {
			return i;
		}
	}

	return -1;
}

// tool_call_id -> name из предшествующих assistant.tool_calls
function buildToolCallNameMap(messages: readonly ChatMessage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
			continue;
		}

		for (const call of msg.tool_calls) {
			map.set(call.id, call.function.name);
		}
	}

	return map;
}

function pathHintFromToolContent(content: string): string | undefined {
	const pathEq = /^path[=:\s]+(\S+)/im.exec(content);
	if (pathEq?.[1]) {
		return pathEq[1].replace(/[,;]$/, '');
	}

	const fileLine = /^Файл\s+(\S+)/m.exec(content);
	if (fileLine?.[1]) {
		return fileLine[1];
	}

	return undefined;
}

// Dedup: повторный tool result для того же name+path -> короткий ref на earlier id
export function dedupToolResults(messages: readonly ChatMessage[]): ShrinkResult {
	const current = cloneMessages(messages);
	const nameById = buildToolCallNameMap(current);
	const seen = new Map<string, string>(); // ключ -> первый tool_call_id
	let changed = false;
	let prunedChars = 0;
	let prunedMessages = 0;

	for (let i = 0; i < current.length; i += 1) {
		const msg = current[i]!;
		if (msg.role !== 'tool') {
			continue;
		}

		const name = (msg.name?.trim() || nameById.get(msg.tool_call_id) || 'tool').toLowerCase();
		const path = pathHintFromToolContent(msg.content)?.toLowerCase() ?? '';
		// Без path не дедупим - иначе все read_file без пути схлопнутся
		if (!path) {
			continue;
		}

		const key = `${name}|${path}`;
		const earlier = seen.get(key);
		if (!earlier) {
			seen.set(key, msg.tool_call_id);
			continue;
		}

		if (msg.content.includes('[duplicate tool result -> earlier #')) {
			continue;
		}

		const next = pruneToolToEarlierRef(msg.content, earlier);
		if (next !== msg.content) {
			prunedChars += Math.max(0, msg.content.length - next.length);
			prunedMessages += 1;
			current[i] = { ...msg, content: next };
			changed = true;
		}
	}

	return { messages: current, changed, prunedChars, prunedMessages };
}

// Soft mid-loop compact без LLM: system + digest старых ходов + последние N ходов
export function softCompactApiMessages(
	messages: readonly ChatMessage[],
	settings: HaratsanSettings,
): ShrinkResult {
	const keepTurns = recentToolKeepCount(settings);
	const current = cloneMessages(messages);
	if (current.length === 0) {
		return { messages: current, changed: false, ...emptyShrinkStats() };
	}

	const system = current[0]?.role === 'system' ? current[0] : undefined;
	const body = system ? current.slice(1) : current;

	const turns: ChatMessage[][] = [];
	let bucket: ChatMessage[] = [];
	for (const msg of body) {
		if (msg.role === 'user' && bucket.length > 0) {
			turns.push(bucket);
			bucket = [];
		}
		bucket.push(msg);
	}
	if (bucket.length > 0) {
		turns.push(bucket);
	}

	if (turns.length <= keepTurns) {
		return { messages: current, changed: false, ...emptyShrinkStats() };
	}

	const older = turns.slice(0, -keepTurns);
	const recent = turns.slice(-keepTurns);
	const olderFlat = older.flat();
	const prunedChars = olderFlat.reduce((sum, m) => sum + contentLength(m.role === 'tool' ? m.content : (m as { content?: string | ChatContentPart[] | null }).content), 0);
	const digest: ChatMessage = {
		role: 'assistant',
		content: `${MID_LOOP_COMPACT_MARKER} Older turns pruned (${olderFlat.length} messages, ~${prunedChars} chars). Continue from recent context.`,
	};

	const next: ChatMessage[] = [
		...(system ? [system] : []),
		digest,
		...recent.flat(),
	];

	return {
		messages: next,
		changed: true,
		prunedChars,
		prunedMessages: olderFlat.length,
	};
}

/**
 * Ужать apiMessages под budget.
 * Порядок eviction: (0) drop superseded reminders + dedup tools ->
 * (1) старые tool bodies -> (2) старые assistant thoughts ->
 * (3) middle turns -> (4) никогда не трогаем last user; system/plan вне shrink.
 */
export function shrinkApiMessages(
	messages: readonly ChatMessage[],
	budget: number,
	settings: HaratsanSettings,
): ShrinkResult {
	let stats = emptyShrinkStats();
	const dropped = dropSupersededReminders(messages);
	stats = addStats(stats, dropped);
	let current = dropped.messages;
	let changed = dropped.changed;

	const deduped = dedupToolResults(current);
	stats = addStats(stats, deduped);
	current = deduped.messages;
	changed = changed || deduped.changed;

	const scratchPruned = pruneScratchEphemeralNoise(current);
	stats = addStats(stats, scratchPruned);
	current = scratchPruned.messages;
	changed = changed || scratchPruned.changed;

	const toolCap = Math.max(
		400,
		Math.min(settings.toolOutputModelMaxChars || settings.toolOutputMaxChars || 2_000, 4_000),
	);
	const keepRecentTools = recentToolKeepCount(settings);

	const applyUserAssistantCaps = (cap: number): void => {
		for (let i = 0; i < current.length; i += 1) {
			const msg = current[i]!;
			if (msg.role === 'system' && i === 0) {
				continue;
			}

			if (msg.role === 'user' || msg.role === 'assistant') {
				const max = msg.role === 'user' ? Math.max(cap, settings.maxInputChars) : cap * 2;
				const before = contentLength(msg.content);
				const nextContent = truncateContent(msg.content, max);
				if (JSON.stringify(nextContent) !== JSON.stringify(msg.content)) {
					stats.prunedChars += Math.max(0, before - contentLength(nextContent));
					current[i] = { ...msg, content: nextContent } as ChatMessage;
					changed = true;
				}
			}
		}
	};

	// Age-weighted: последние N tool - cap; старше - digest
	const applyToolCapsAgeWeighted = (recentCap: number): void => {
		const idxs = toolMessageIndices(current);
		const recentFrom = Math.max(0, idxs.length - keepRecentTools);
		const recentSet = new Set(idxs.slice(recentFrom));

		for (let i = 0; i < current.length; i += 1) {
			const msg = current[i]!;
			if (msg.role !== 'tool') {
				continue;
			}

			let next: string;
			if (recentSet.has(i)) {
				next = truncateText(msg.content, recentCap);
			} else {
				next = pruneToolToDigest(msg.content);
			}

			if (next !== msg.content) {
				stats.prunedChars += Math.max(0, msg.content.length - next.length);
				stats.prunedMessages += 1;
				current[i] = { ...msg, content: next };
				changed = true;
			}
		}
	};

	// Старые assistant thoughts / reasoning, если поля есть в apiMessages
	const pruneOldAssistantThoughts = (): void => {
		const assistantIdxs: number[] = [];
		for (let i = 0; i < current.length; i += 1) {
			if (current[i]!.role === 'assistant') {
				assistantIdxs.push(i);
			}
		}

		const keepRecent = Math.min(2, assistantIdxs.length);
		const dropBefore = Math.max(0, assistantIdxs.length - keepRecent);

		for (let k = 0; k < dropBefore; k += 1) {
			const i = assistantIdxs[k]!;
			const msg = current[i]! as ChatMessage & AssistantThoughtFields;
			if (msg.role !== 'assistant') {
				continue;
			}

			let localChanged = false;
			let nextContent = msg.content;
			const before = contentLength(msg.content);
			if (typeof msg.content === 'string' && msg.content.length > 800) {
				nextContent = truncateText(msg.content, 500);
				localChanged = true;
			}

			if (msg.thinking || msg.reasoning_content || (typeof msg.reasoning === 'string' && msg.reasoning)) {
				localChanged = true;
			}

			if (localChanged) {
				stats.prunedChars += Math.max(0, before - contentLength(nextContent));
				stats.prunedMessages += 1;
				// thoughts/reasoning сбрасываем; content ужимаем при необходимости
				current[i] = {
					role: 'assistant',
					content: nextContent,
					...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
				};
				changed = true;
			}
		}
	};

	// (1) тела tool: age-weighted + лимиты user/assistant
	applyToolCapsAgeWeighted(toolCap);
	applyUserAssistantCaps(toolCap);
	if (!isOverContextBudget(estimateChatMessagesTokens(current), budget)) {
		return {
			messages: current,
			changed,
			...stats,
		};
	}

	applyToolCapsAgeWeighted(Math.max(200, Math.floor(toolCap / 3)));
	applyUserAssistantCaps(Math.max(200, Math.floor(toolCap / 3)));
	if (!isOverContextBudget(estimateChatMessagesTokens(current), budget)) {
		return {
			messages: current,
			changed,
			...stats,
		};
	}

	// (2) старые assistant thoughts
	pruneOldAssistantThoughts();
	if (!isOverContextBudget(estimateChatMessagesTokens(current), budget)) {
		return {
			messages: current,
			changed,
			...stats,
		};
	}

	// (3) middle turns; (4) никогда не удаляем last user; system[0] сохраняем
	const keepTail = KEEP_TAIL_MESSAGES;
	while (current.length > keepTail + 1 && isOverContextBudget(estimateChatMessagesTokens(current), budget)) {
		const lastUserIdx = findLastUserIndex(current);
		let removeIdx = -1;
		const middleEnd = current.length - keepTail;
		for (let i = 1; i < middleEnd; i += 1) {
			if (i === lastUserIdx) {
				continue;
			}

			removeIdx = i;
			break;
		}

		if (removeIdx < 0) {
			break;
		}

		const removed = current[removeIdx]!;
		stats.prunedChars += contentLength(removed.role === 'tool' ? removed.content : (removed as { content?: string | ChatContentPart[] | null }).content);
		stats.prunedMessages += 1;
		current.splice(removeIdx, 1);
		changed = true;
	}

	return { messages: current, changed, ...stats };
}

export function resolveContextBudget(settings: HaratsanSettings): number {
	return getEffectiveContextBudget(
		settings,
		getCachedNCtx(settings.baseUrl, settings.model),
	);
}

export function rememberOverflowNCtx(settings: HaratsanSettings, info: ContextOverflowInfo): void {
	if (info.nCtx) {
		setCachedNCtx(settings.baseUrl, settings.model, info.nCtx);
	}
}

export function throwFriendlyOverflow(info: ContextOverflowInfo, budget: number): never {
	throw new ContextBudgetExceededError(formatContextOverflowUserMessage(info, budget));
}

export function throwPreflightOverflow(estimated: number, budget: number, nCtx?: number): never {
	throw new ContextBudgetExceededError(vscode.l10n.t('chat.contextOverflow.preflight', estimated, budget, nCtx ?? '-'));
}

export interface CompleteWithContextGuardOptions {
	client: LlmClient;
	settings: HaratsanSettings;
	getMessages: () => ChatMessage[];
	setMessages: (messages: ChatMessage[]) => void;
	complete: (messages: ChatMessage[]) => Promise<CompleteResult>;
	// Уведомление UI о retry/compact
	onStatus?: (detail: string) => void;
	// Счётчики prune для UI/debug
	onPrune?: (info: ShrinkStats) => void;
	signal?: AbortSignal;
}

// Preflight shrink + reactive overflow retry вокруг одного complete()
export async function completeWithContextGuard(opts: CompleteWithContextGuardOptions): Promise<CompleteResult> {
	const policy = opts.settings.contextOverflowPolicy;
	let retries = 0;

	while (true) {
		if (opts.signal?.aborted) {
			const err = new Error('Aborted');
			err.name = 'AbortError';
			throw err;
		}

		const settings = opts.settings;
		let messages = opts.getMessages();
		const budget = resolveContextBudget(settings);
		let estimated = estimateChatMessagesTokens(messages);

		if (isNearContextBudget(estimated, budget) || isOverContextBudget(estimated, budget)) {
			if (policy === 'fail_fast' && isOverContextBudget(estimated, budget)) {
				throwPreflightOverflow(estimated, budget, getCachedNCtx(settings.baseUrl, settings.model));
			}

			if (policy !== 'fail_fast') {
				opts.onStatus?.(vscode.l10n.t('chat.contextOverflow.shrinking'));
				const shrunk = shrinkApiMessages(messages, budget, settings);
				if (shrunk.changed) {
					opts.setMessages(shrunk.messages);
					messages = shrunk.messages;
					estimated = estimateChatMessagesTokens(messages);
					if (shrunk.prunedChars > 0 || shrunk.prunedMessages > 0) {
						opts.onPrune?.({ prunedChars: shrunk.prunedChars, prunedMessages: shrunk.prunedMessages });
					}
				}
			}

			if (isOverContextBudget(estimated, budget)) {
				if (policy === 'ask' || policy === 'fail_fast') {
					throwPreflightOverflow(
						estimated,
						budget,
						getCachedNCtx(settings.baseUrl, settings.model),
					);
				}
				// auto: всё равно пробуем HTTP - сервер точнее; reactive подхватит
			}
		}

		try {
			return await opts.complete(messages);
		} catch (err) {
			const info = parseContextOverflow(err);
			if (!info) {
				throw err;
			}

			rememberOverflowNCtx(settings, info);
			const newBudget = resolveContextBudget(settings);

			if (policy === 'fail_fast' || policy === 'ask') {
				throwFriendlyOverflow(info, newBudget);
			}

			if (retries >= MAX_CONTEXT_OVERFLOW_RETRIES) {
				throwFriendlyOverflow(info, newBudget);
			}

			retries += 1;
			opts.onStatus?.(vscode.l10n.t('chat.contextOverflow.retrying', retries, MAX_CONTEXT_OVERFLOW_RETRIES));

			const shrunk = shrinkApiMessages(opts.getMessages(), newBudget, settings);
			opts.setMessages(shrunk.messages);
			if (shrunk.changed && (shrunk.prunedChars > 0 || shrunk.prunedMessages > 0)) {
				opts.onPrune?.({ prunedChars: shrunk.prunedChars, prunedMessages: shrunk.prunedMessages });
			}
			if (!shrunk.changed && estimateChatMessagesTokens(shrunk.messages) > newBudget) {
				throwFriendlyOverflow(info, newBudget);
			}
		}
	}
}
