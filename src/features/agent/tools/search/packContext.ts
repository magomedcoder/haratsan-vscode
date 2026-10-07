import * as vscode from 'vscode';
import { getIndexManager } from '../../../index/IndexManager';
import { packContext, type ContextHit } from '../../../index/contextEngine';
import { AGENT_LIMITS } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';
import { findCodeTool } from './findCode';
import { fitHitsToTokenBudget, resolveMaxTokensArg, toProvenanceHit} from './fitHitsTokenBudget';
import type { ProvenanceHit} from './fitHitsTokenBudget';

const DEFAULT_BUDGET = 12_000;
const MAX_BUDGET = 48_000;
const DEFAULT_MAX_TOKENS = 3_000;
const MAX_TOKENS_CAP = 16_000;

interface PackRawHit extends ContextHit {
	tool: string;
	reason: string;
}

// Собрать компактный context pack по запросу (find_code + codebase hits под char + token budget).
export const packContextTool: ToolDefinition = {
	name: 'pack_context',
	description: 'По тексту задачи собрать компактный набор фрагментов кода (find_code + индекс) в пределах char/token budget; hits с provenance (path, range, tool, reason, score).',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Задача / вопрос / что искать в кодовой базе',
			},
			budget_chars: {
				type: 'integer',
				description: `Лимит символов контекста (по умолчанию ${DEFAULT_BUDGET}, max ${MAX_BUDGET})`,
			},
			max_tokens: {
				type: 'integer',
				description: `Лимит токенов (оценка) для packed hits (по умолчанию ${DEFAULT_MAX_TOKENS}, max ${MAX_TOKENS_CAP}). Синоним: maxTokens.`,
			},
			max_hits: {
				type: 'integer',
				description: 'Сколько сырых hits запросить у find_code / индекса (по умолчанию 16)',
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
				content: 'pack_context: нужен параметр query',
			};
		}

		const budget = Math.min(
			MAX_BUDGET,
			Math.max(1_000, asOptionalInt(args, 'budget_chars') ?? DEFAULT_BUDGET),
		);
		const maxTokens = resolveMaxTokensArg(args, DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP, asOptionalInt);
		const maxHits = Math.min(
			AGENT_LIMITS.maxSearchMatches,
			Math.max(4, asOptionalInt(args, 'max_hits') ?? 16),
		);

		if (!vscode.workspace.workspaceFolders?.length) {
			return {
				ok: true,
				content: JSON.stringify({
					query,
					budgetChars: budget,
					maxTokens,
					tokensUsed: 0,
					truncated: false,
					hitCount: 0,
					hits: [] as ProvenanceHit[],
					text: '',
					notes: ['нет workspace'],
				}, null, 2),
			};
		}

		const rawHits: PackRawHit[] = [];
		const notes: string[] = [];

		// гибрид find_code
		try {
			const fc = await findCodeTool.execute({
				query,
				intent: 'mixed',
				max_results: maxHits,
			}, ctx);
			if (fc.ok) {
				const parsed = JSON.parse(fc.content) as {
					hits?: Array<{
						path: string;
						line?: number;
						snippet?: string;
						score?: number;
						sources?: string[];
						why?: string;
					}>;
					notes?: string[];
				};
				for (const h of parsed.hits ?? []) {
					const why = (h.why ?? '').trim();
					const sources = (h.sources ?? []).filter(Boolean).join(', ');
					rawHits.push({
						source: 'codebase',
						path: h.path,
						startLine: h.line,
						score: (h.score ?? 0.5) * 10,
						snippet: (h.snippet ?? h.path).slice(0, 1_200),
						tool: 'find_code',
						reason: why || sources || 'find_code hybrid',
					});
				}
				if (parsed.notes?.length) {
					notes.push(...parsed.notes);
				}
			} else {
				notes.push(`find_code: ${fc.content}`);
			}
		} catch (err) {
			notes.push(`find_code: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Дополнительно trigram index
		const manager = getIndexManager();
		if (manager) {
			try {
				const ranked = await manager.search(query, Math.min(8, maxHits));
				for (const h of ranked) {
					rawHits.push({
						source: 'codebase',
						path: h.path,
						startLine: h.startLine,
						endLine: h.endLine,
						score: h.score,
						snippet: h.snippet.slice(0, 1_200),
						tool: 'codebase_search',
						reason: 'trigram index',
					});
				}
			} catch (err) {
				notes.push(`codebase: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Сначала char-pack (rank + char budget), затем eviction по token budget (низкий score первым).
		// packContext сохраняет те же object refs хитов - tool/reason не теряются.
		const pack = packContext(rawHits, budget);
		const withMeta = (pack.hits as PackRawHit[]).map((h) =>
			toProvenanceHit({
				path: h.path,
				startLine: h.startLine,
				endLine: h.endLine,
				score: h.score,
				snippet: h.snippet,
				tool: h.tool ?? 'pack_context',
				reason: h.reason ?? h.source,
				source: h.source,
			}),
		);

		const fitted = fitHitsToTokenBudget(withMeta, maxTokens);
		const textPack = packContext(
			fitted.kept.map((h) => ({
				source: (h.source as ContextHit['source']) ?? 'codebase',
				path: h.path,
				startLine: h.startLine ?? undefined,
				endLine: h.endLine ?? undefined,
				score: h.score,
				snippet: h.snippet,
			})),
			budget,
		);

		if (fitted.truncated) {
			notes.push(`token budget: dropped ${fitted.dropped.length} lowest-ranked hit(s)`);
		}

		return {
			ok: true,
			content: JSON.stringify({
				query,
				budgetChars: budget,
				maxTokens: fitted.maxTokens,
				tokensUsed: fitted.tokensUsed,
				truncated: fitted.truncated,
				hitCount: fitted.kept.length,
				notes,
				hits: fitted.kept,
				text: textPack.text,
			}, null, 2).slice(0, budget + 2_000),
		};
	},
};
