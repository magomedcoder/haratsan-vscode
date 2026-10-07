import * as vscode from 'vscode';
import { getIndexManager } from '../../../index/IndexManager';
import { loadManifest } from '../../../index/store';
import { tokenize } from '../../../index/trigram';
import { AGENT_LIMITS } from '../../policy';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { resolveWorkspacePath, throwIfAborted } from '../../workspacePath';
import { fitHitsToTokenBudget, resolveMaxTokensArg, toProvenanceHit } from './fitHitsTokenBudget';

const DEFAULT_MAX = 10;
const DEFAULT_MAX_TOKENS = 2_000;
const MAX_TOKENS_CAP = 12_000;

function extractRangeText(text: string, startLine?: number, endLine?: number): string {
	if (startLine === undefined && endLine === undefined) {
		return text;
	}

	const lines = text.split(/\r?\n/);
	const start = Math.max(0, (startLine ?? 1) - 1);
	const end = Math.min(lines.length, endLine ?? startLine ?? lines.length);
	return lines.slice(start, end).join('\n');
}

// Похожие фрагменты через overlap триграмм индекса / query.
export const similarCodeTool: ToolDefinition = {
	name: 'similar_code',
	description: 'Найти похожие фрагменты кода по пути (+ опц. диапазон строк / query) через trigram/index overlap; hits с provenance и token budget.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Путь к файлу в workspace',
			},
			start_line: {
				type: 'integer',
				description: 'Начало диапазона (1-based, опционально)',
			},
			end_line: {
				type: 'integer',
				description: 'Конец диапазона (1-based, опционально)',
			},
			query: {
				type: 'string',
				description: 'Доп. текст/фраза для поиска похожего (если нет - берётся текст из path/range)',
			},
			max_results: {
				type: 'integer',
				description: `Лимит hits (по умолчанию ${DEFAULT_MAX})`,
			},
			max_tokens: {
				type: 'integer',
				description: `Лимит токенов (оценка) для hits (по умолчанию ${DEFAULT_MAX_TOKENS}, max ${MAX_TOKENS_CAP}). Синоним: maxTokens.`,
			},
		},
		required: ['path'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const relPath = asString(args, 'path').trim().replace(/\\/g, '/');
		if (!relPath) {
			return {
				ok: false,
				content: 'similar_code: нужен параметр path',
			};
		}

		const startLine = asOptionalInt(args, 'start_line');
		const endLine = asOptionalInt(args, 'end_line');
		const maxResults = Math.min(
			AGENT_LIMITS.maxSearchMatches,
			Math.max(1, asOptionalInt(args, 'max_results') ?? DEFAULT_MAX),
		);
		const maxTokens = resolveMaxTokensArg(args, DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP, asOptionalInt);

		let seed = asString(args, 'query', '').trim();
		try {
			const resolved = await resolveWorkspacePath(relPath);
			const doc = await vscode.workspace.openTextDocument(resolved.uri);
			const body = extractRangeText(doc.getText(), startLine, endLine);
			if (!seed) {
				seed = body.slice(0, 2_000);
			} else {
				seed = `${seed}\n${body.slice(0, 1_000)}`;
			}
		} catch (err) {
			if (!seed) {
				return {
					ok: false,
					content: err instanceof Error ? err.message : String(err),
				};
			}
		}

		if (!seed.trim()) {
			return {
				ok: false,
				content: 'similar_code: пустой seed (файл/range/query)',
			};
		}

		const manager = getIndexManager();
		if (!manager) {
			return {
				ok: false,
				content: 'similar_code: IndexManager не инициализирован',
			};
		}

		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const hits = await manager.search(seed, maxResults + 8);
		const seedGrams = new Set(tokenize(seed));
		const manifest = folder ? await loadManifest(folder) : undefined;

		const enriched = hits.filter((h) => h.path !== relPath || (startLine !== undefined && h.startLine !== startLine))
			.map((h) => {
				let overlap = h.score;
				if (manifest && seedGrams.size > 0) {
					const chunk = manifest.chunks[h.chunkId];
					if (chunk) {
						const grams = tokenize(`${chunk.path} ${chunk.text}`);
						let hit = 0;
						for (const g of grams) {
							if (seedGrams.has(g)) {
								hit += 1;
							}
						}
						overlap = hit / Math.max(1, seedGrams.size);
					}
				}

				return toProvenanceHit({
					path: h.path,
					startLine: h.startLine,
					endLine: h.endLine,
					score: Math.min(1, overlap),
					snippet: h.snippet.slice(0, 240),
					tool: 'similar_code',
					reason: 'trigram overlap',
					source: 'codebase',
				});
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, maxResults);

		const fitted = fitHitsToTokenBudget(enriched, maxTokens);

		return {
			ok: true,
			content: JSON.stringify({
				path: relPath,
				startLine: startLine ?? null,
				endLine: endLine ?? null,
				maxTokens: fitted.maxTokens,
				tokensUsed: fitted.tokensUsed,
				truncated: fitted.truncated,
				hits: fitted.kept,
			}, null, 2),
		};
	},
};
