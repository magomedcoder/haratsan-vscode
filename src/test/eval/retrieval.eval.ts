import * as assert from 'assert';
import { chunkFileContent } from '../../features/index/chunk.js';
import { aggregateRetrievalMetrics, assertRetrievalGate, DEFAULT_RETRIEVAL_GATE, hitAtK, precisionAtK, recallAtK, reciprocalRank } from '../../features/index/retrievalMetrics.js';
import type { IndexManifest } from '../../features/index/types.js';
import { buildTrigramIndex, searchTrigrams } from '../../features/index/trigram.js';
import { LOCAL_HASH_MODEL_ID, localHashEmbed } from '../../features/index/localHashEmbed.js';
import { emptyVectorIndex, searchVectorIndex, syncLocalHashVectors } from '../../features/index/vectorStore.js';
import { FIND_CODE_MAX_CHARS, mergeFindCodeHits, truncateFindCodeJson } from '../../features/agent/tools/search/findCodeMerge.js';
import type { FindCodeRawHit } from '../../features/agent/tools/search/findCodeMerge.js';
import { buildTreeFromPaths, formatOutline, heuristicFileSummary, isProjectMapStale } from '../../features/index/projectMap.js';
import type { ProjectMapDocument } from '../../features/index/projectMap.js';

// Мини-корпус для offline trigram (без remote embeddings)
function buildOfflineTrigramCorpus(): IndexManifest {
	const files: Array<{ path: string; content: string }> = [
		{
			path: 'src/auth/login.ts',
			content: [
				'export function authenticateUser(token: string) {',
				'  return verifyToken(token);',
				'}',
				'',
			].join('\n'),
		},
		{
			path: 'src/auth/session.ts',
			content: [
				'export class SessionManager {',
				'  createSession(userId: string) {',
				'    return { userId };',
				'  }',
				'}',
				'',
			].join('\n'),
		},
		{
			path: 'src/db/query.ts',
			content: [
				'export function runSqlQuery(sql: string) {',
				'  return executeSql(sql);',
				'}',
				'',
			].join('\n'),
		},
		{
			path: 'src/ui/button.ts',
			content: [
				'export function renderButton(label: string) {',
				'  return `<button>${label}</button>`;',
				'}',
				'',
			].join('\n'),
		},
		{
			path: 'docs/permissions.md',
			content: 'Approval policy confirm always allow denylist shell edits\n',
		},
	];

	const chunks = files.flatMap((f) => chunkFileContent(f.path, f.content));
	const byId = Object.fromEntries(chunks.map((c) => [c.id, c]));
	return {
		version: 1,
		updatedAt: '2026-09-15T00:00:00.000Z',
		files: {},
		chunks: byId,
		trigrams: buildTrigramIndex(chunks),
		dirDigests: {},
	};
}

// Ранжированные пути по offline trigram (chunk -> path, max score)
function rankedPathsFromTrigram(manifest: IndexManifest, query: string, cap: number): string[] {
	const hits = searchTrigrams(manifest, query, cap * 4);
	const best = new Map<string, number>();
	for (const hit of hits) {
		const chunk = manifest.chunks[hit.chunkId];
		if (!chunk) {
			continue;
		}

		const prev = best.get(chunk.path) ?? 0;
		if (hit.score > prev) {
			best.set(chunk.path, hit.score);
		}
	}
	
	return [...best.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, cap)
		.map(([path]) => path);
}

suite('eval/retrieval', () => {
	test('fixture: symbol-like hits merge path+line и boost multi-source', () => {
		const raw: FindCodeRawHit[] = [
			{
				path: 'src/features/agent/AgentSession.ts',
				line: 218,
				snippet: 'export class AgentSession',
				score: 0.75,
				source: 'grep',
				why: 'symbol text',
			},
			{
				path: 'src/features/agent/AgentSession.ts',
				line: 218,
				snippet: 'export class AgentSession {',
				score: 0.82,
				source: 'codebase_search',
				why: 'trigram',
			},
			{
				path: 'src/features/chat/ChatSession.ts',
				line: 90,
				snippet: 'private readonly agent: AgentSession',
				score: 0.55,
				source: 'grep',
				why: 'reference',
			},
		];
		const merged = mergeFindCodeHits(raw, 5);
		assert.strictEqual(merged.length, 2);
		const top = merged.find((h) => h.path.includes('AgentSession.ts') && h.line === 218)!;
		assert.ok(top);
		assert.ok(top.sources.includes('grep') && top.sources.includes('codebase_search'));
		assert.ok(top.score > 0.82);
	});

	test('fixture: path intent предпочитает file_search score', () => {
		const raw: FindCodeRawHit[] = [
			{
				path: 'src/a/foo.ts',
				score: 0.4,
				source: 'grep',
				why: 'text',
			},
			{
				path: 'src/a/fooBar.ts',
				score: 0.95,
				source: 'file_search',
				why: 'path',
			},
			{
				path: 'src/b/other.ts',
				score: 0.7,
				source: 'glob',
				why: 'glob',
			},
		];
		const merged = mergeFindCodeHits(raw, 3);
		assert.strictEqual(merged[0]!.path, 'src/a/fooBar.ts');
		assert.strictEqual(merged[0]!.sources[0], 'file_search');
	});

	test('fixture: truncateFindCodeJson сохраняет query при обрезке', () => {
		const hits = Array.from({ length: 30 }, (_, i) => ({
			path: `pkg/module_${i}/index.ts`,
			snippet: 'y'.repeat(180),
			score: 1 - i * 0.02,
			sources: ['grep'],
			why: 'fixture',
		}));
		const json = truncateFindCodeJson({
			query: 'localize bug',
			hits,
		}, FIND_CODE_MAX_CHARS);
		assert.ok(json.length <= FIND_CODE_MAX_CHARS);
		const parsed = JSON.parse(json) as {
			query?: string;
			truncated?: boolean;
		};
		assert.strictEqual(parsed.query, 'localize bug');
	});

	test('fixture: project map outline содержит модуль и summary', () => {
		const summaries = new Map<string, string>([
			['src/features/index/projectMap.ts', heuristicFileSummary('src/features/index/projectMap.ts')],
			['src/features/agent/tools/search/findCode.ts', heuristicFileSummary('src/features/agent/tools/search/findCode.ts')],
		]);
		const { tree, fileCount } = buildTreeFromPaths([...summaries.keys()], {
			maxDepth: 8,
			summaries,
		});
		assert.strictEqual(fileCount, 2);
		const outline = formatOutline(tree);
		assert.ok(outline.includes('projectMap.ts'));
		assert.ok(outline.includes('findCode.ts') || outline.includes('search'));
	});

	test('fixture: stale map после обновления индекса', () => {
		const cached: ProjectMapDocument = {
			updatedAt: '2026-01-01T00:00:00.000Z',
			source: 'index',
			fileCount: 2,
			maxDepth: 8,
			truncated: false,
			tree: [],
		};
		assert.strictEqual(isProjectMapStale(cached, '2026-09-01T00:00:00.000Z'), true);
		assert.strictEqual(isProjectMapStale(cached, '2026-01-01T00:00:00.000Z'), false);
	});

	test('metrics: precision@k / hit@k / RR / recall@k на известных ranked списках', () => {
		const ranked = [
			'src/auth/login.ts',
			'src/ui/button.ts',
			'src/db/query.ts',
		];
		const relevant = ['src/auth/login.ts'];
		assert.strictEqual(precisionAtK(ranked, relevant, 3), 1 / 3);
		assert.strictEqual(hitAtK(ranked, relevant, 3), true);
		assert.strictEqual(reciprocalRank(ranked, relevant), 1);
		assert.strictEqual(recallAtK(ranked, relevant, 3), 1);
		assert.strictEqual(hitAtK(['src/ui/button.ts'], relevant, 1), false);
		assert.strictEqual(reciprocalRank(['src/ui/button.ts', 'src/auth/login.ts'], relevant), 0.5);
		assert.strictEqual(recallAtK(ranked, ['src/auth/login.ts', 'src/db/query.ts'], 3), 1);
		assert.strictEqual(recallAtK(ranked, ['src/auth/login.ts', 'missing.ts'], 1), 0.5);
	});

	test('quality gate: offline trigram corpus проходит CI пороги (без embeddings)', () => {
		const manifest = buildOfflineTrigramCorpus();
		const k = DEFAULT_RETRIEVAL_GATE.k;
		const cases = [
			{
				query: 'authenticateUser token',
				rankedPaths: rankedPathsFromTrigram(manifest, 'authenticateUser token', k),
				relevant: ['src/auth/login.ts'],
			},
			{
				query: 'SessionManager createSession',
				rankedPaths: rankedPathsFromTrigram(manifest, 'SessionManager createSession', k),
				relevant: ['src/auth/session.ts'],
			},
			{
				query: 'runSqlQuery executeSql',
				rankedPaths: rankedPathsFromTrigram(manifest, 'runSqlQuery executeSql', k),
				relevant: ['src/db/query.ts'],
			},
			{
				query: 'approval policy confirm denylist',
				rankedPaths: rankedPathsFromTrigram(manifest, 'approval policy confirm denylist', k),
				relevant: ['docs/permissions.md'],
			},
			// Парафразы / более «жёсткие» запросы (токены всё ещё пересекаются с корпусом)
			{
				query: 'verify token authenticate',
				rankedPaths: rankedPathsFromTrigram(manifest, 'verify token authenticate', k),
				relevant: ['src/auth/login.ts'],
			},
			{
				query: 'sql query execute',
				rankedPaths: rankedPathsFromTrigram(manifest, 'sql query execute', k),
				relevant: ['src/db/query.ts'],
			},
		];

		for (const c of cases) {
			assert.ok(
				c.rankedPaths.length > 0,
				`trigram не вернул hits для «${c.query}» - проверь корпус/tokenize`,
			);
		}

		const metrics = aggregateRetrievalMetrics(cases, k);
		assertRetrievalGate(metrics, DEFAULT_RETRIEVAL_GATE);
		assert.ok(metrics.hitRate >= DEFAULT_RETRIEVAL_GATE.minHitRate);
		assert.ok(metrics.meanPrecisionAtK >= DEFAULT_RETRIEVAL_GATE.minMeanPrecisionAtK);
		assert.ok(metrics.simpleScore >= DEFAULT_RETRIEVAL_GATE.minSimpleScore);
	});

	test('quality gate: local-hash vector index на offline корпусе', () => {
		const manifest = buildOfflineTrigramCorpus();
		const index = syncLocalHashVectors(manifest, emptyVectorIndex());
		const k = DEFAULT_RETRIEVAL_GATE.k;
		const rank = (query: string) =>
			searchVectorIndex(index, localHashEmbed(query), {
				maxResults: k,
				model: LOCAL_HASH_MODEL_ID,
				source: 'local-hash',
			}).map((h) => h.path);

		const cases = [
			{
				query: 'authenticate user token',
				rankedPaths: rank('authenticate user token'),
				relevant: ['src/auth/login.ts'],
			},
			{
				query: 'create session manager',
				rankedPaths: rank('create session manager'),
				relevant: ['src/auth/session.ts'],
			},
			{
				query: 'run sql query',
				rankedPaths: rank('run sql query'),
				relevant: ['src/db/query.ts'],
			},
			{
				query: 'approval policy denylist',
				rankedPaths: rank('approval policy denylist'),
				relevant: ['docs/permissions.md'],
			},
		];

		for (const c of cases) {
			assert.ok(c.rankedPaths.length > 0, `vector пуст для «${c.query}»`);
		}

		const metrics = aggregateRetrievalMetrics(cases, k);
		assertRetrievalGate(metrics, {
			...DEFAULT_RETRIEVAL_GATE,
			minMeanPrecisionAtK: 0.3,
			minSimpleScore: 0.65,
		});
	});

	test('quality gate: mergeFindCodeHits держит gold path в top-k (score gate)', () => {
		const raw: FindCodeRawHit[] = [
			{
				path: 'src/noise/a.ts',
				score: 0.4,
				source: 'grep',
				why: 'noise',
			},
			{
				path: 'src/auth/login.ts',
				score: 0.9,
				source: 'codebase_search',
				why: 'gold',
			},
			{
				path: 'src/noise/b.ts',
				score: 0.5,
				source: 'glob',
				why: 'noise',
			},
			{
				path: 'src/auth/login.ts',
				score: 0.7,
				source: 'grep',
				why: 'gold-grep',
			},
		];
		const merged = mergeFindCodeHits(raw, 5);
		const ranked = merged.map((h) => h.path);
		const metrics = aggregateRetrievalMetrics(
			[
				{
					query: 'authenticateUser',
					rankedPaths: ranked,
					relevant: ['src/auth/login.ts'],
				},
			],
			DEFAULT_RETRIEVAL_GATE.k,
		);
		assertRetrievalGate(metrics, {
			...DEFAULT_RETRIEVAL_GATE,
			minMeanPrecisionAtK: 0.3,
			minSimpleScore: 0.7,
		});
		assert.strictEqual(ranked[0], 'src/auth/login.ts');
	});
});
