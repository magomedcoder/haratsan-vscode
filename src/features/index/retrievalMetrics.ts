/**
 * Метрики качества retrieval для offline eval / CI gate.
 * Без сетевых embeddings: работает по уже ранжированным путям (trigram / merge fixtures).
 */

// Нормализация пути для сравнения (POSIX, без ведущего ./)
export function normalizeRetrievalPath(path: string): string {
	return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function toRelevantSet(relevant: Iterable<string>): Set<string> {
	const set = new Set<string>();
	for (const item of relevant) {
		const n = normalizeRetrievalPath(item);
		if (n) {
			set.add(n);
		}
	}

	return set;
}

function isRelevantPath(path: string, relevant: Set<string>): boolean {
	const n = normalizeRetrievalPath(path);
	if (relevant.has(n)) {
		return true;
	}

	// Допускаем совпадение по basename / суффиксу (chunk id -> path)
	for (const r of relevant) {
		if (n === r || n.endsWith(`/${r}`) || r.endsWith(`/${n}`)) {
			return true;
		}
	}

	return false;
}

// Precision@k: доля релевантных среди top-k (пустой ranked -> 0)
export function precisionAtK(
	rankedPaths: readonly string[],
	relevant: Iterable<string>,
	k: number,
): number {
	if (k <= 0) {
		return 0;
	}

	const rel = toRelevantSet(relevant);
	const top = rankedPaths.slice(0, k).map(normalizeRetrievalPath).filter(Boolean);
	if (top.length === 0) {
		return 0;
	}

	let hits = 0;
	for (const p of top) {
		if (isRelevantPath(p, rel)) {
			hits += 1;
		}
	}

	return hits / Math.min(k, top.length);
}

// Hit@k: есть ли хотя бы один релевантный в top-k
export function hitAtK(
	rankedPaths: readonly string[],
	relevant: Iterable<string>,
	k: number,
): boolean {
	if (k <= 0) {
		return false;
	}
	const rel = toRelevantSet(relevant);
	const top = rankedPaths.slice(0, k);
	return top.some((p) => isRelevantPath(p, rel));
}

// Recall@k: доля релевантных, попавших в top-k (0 если relevant пуст)
export function recallAtK(
	rankedPaths: readonly string[],
	relevant: Iterable<string>,
	k: number,
): number {
	const rel = toRelevantSet(relevant);
	if (rel.size === 0 || k <= 0) {
		return 0;
	}
	
	const top = rankedPaths.slice(0, k);
	let found = 0;
	for (const r of rel) {
		if (top.some((p) => isRelevantPath(p, new Set([r])))) {
			found += 1;
		}
	}

	return found / rel.size;
}

/**
 * Reciprocal rank: 1/rank первого релевантного (1-based), иначе 0.
 * Rank считается в пределах всего ranked-списка (не только k).
 */
export function reciprocalRank(
	rankedPaths: readonly string[],
	relevant: Iterable<string>,
): number {
	const rel = toRelevantSet(relevant);
	for (let i = 0; i < rankedPaths.length; i += 1) {
		if (isRelevantPath(rankedPaths[i]!, rel)) {
			return 1 / (i + 1);
		}
	}
	return 0;
}

export interface RetrievalCaseInput {
	query: string;
	// Ранжированные пути (уже отсортированы по убыванию score)
	rankedPaths: readonly string[];
	// Золотые релевантные пути
	relevant: readonly string[];
}

export interface RetrievalCaseMetrics {
	query: string;
	k: number;
	precisionAtK: number;
	hit: boolean;
	reciprocalRank: number;
	// Простой score кейса: среднее hit (0|1), P@k и RR
	simpleScore: number;
}

export interface RetrievalSuiteMetrics {
	k: number;
	cases: RetrievalCaseMetrics[];
	// Доля кейсов с hit@k
	hitRate: number;
	meanPrecisionAtK: number;
	meanReciprocalRank: number;
	// Простой suite score: среднее simpleScore по кейсам
	simpleScore: number;
}

export interface RetrievalGateThresholds {
	k: number;
	// Мин. hit-rate по кейсам (0..1)
	minHitRate: number;
	// Мин. средний precision@k
	minMeanPrecisionAtK: number;
	// Мин. простой suite score
	minSimpleScore: number;
}

// Пороги CI для offline trigram/merge corpus (без remote embeddings)
export const DEFAULT_RETRIEVAL_GATE: RetrievalGateThresholds = {
	k: 3,
	minHitRate: 1,
	minMeanPrecisionAtK: 0.4,
	minSimpleScore: 0.7,
};

export function scoreRetrievalCase(input: RetrievalCaseInput, k: number): RetrievalCaseMetrics {
	const precision = precisionAtK(input.rankedPaths, input.relevant, k);
	const hit = hitAtK(input.rankedPaths, input.relevant, k);
	const rr = reciprocalRank(input.rankedPaths, input.relevant);
	const simpleScore = (Number(hit) + precision + rr) / 3;
	return {
		query: input.query,
		k,
		precisionAtK: precision,
		hit,
		reciprocalRank: rr,
		simpleScore,
	};
}

export function aggregateRetrievalMetrics(
	cases: readonly RetrievalCaseInput[],
	k: number = DEFAULT_RETRIEVAL_GATE.k,
): RetrievalSuiteMetrics {
	const scored = cases.map((c) => scoreRetrievalCase(c, k));
	const n = scored.length;
	if (n === 0) {
		return {
			k,
			cases: [],
			hitRate: 0,
			meanPrecisionAtK: 0,
			meanReciprocalRank: 0,
			simpleScore: 0,
		};
	}

	const hitRate = scored.filter((c) => c.hit).length / n;
	const meanPrecisionAtK = scored.reduce((s, c) => s + c.precisionAtK, 0) / n;
	const meanReciprocalRank = scored.reduce((s, c) => s + c.reciprocalRank, 0) / n;
	const simpleScore = scored.reduce((s, c) => s + c.simpleScore, 0) / n;

	return {
		k,
		cases: scored,
		hitRate,
		meanPrecisionAtK,
		meanReciprocalRank,
		simpleScore,
	};
}

export interface RetrievalGateResult {
	ok: boolean;
	failures: string[];
	metrics: RetrievalSuiteMetrics;
	thresholds: RetrievalGateThresholds;
}

// Проверка порогов без throw - удобно для отчёта в тесте
export function checkRetrievalGate(
	metrics: RetrievalSuiteMetrics,
	thresholds: RetrievalGateThresholds = DEFAULT_RETRIEVAL_GATE,
): RetrievalGateResult {
	const failures: string[] = [];
	if (metrics.hitRate + 1e-9 < thresholds.minHitRate) {
		failures.push(
			`hitRate@${metrics.k}=${metrics.hitRate.toFixed(3)} < min ${thresholds.minHitRate}`,
		);
	}

	if (metrics.meanPrecisionAtK + 1e-9 < thresholds.minMeanPrecisionAtK) {
		failures.push(
			`meanPrecision@${metrics.k}=${metrics.meanPrecisionAtK.toFixed(3)} < min ${thresholds.minMeanPrecisionAtK}`,
		);
	}

	if (metrics.simpleScore + 1e-9 < thresholds.minSimpleScore) {
		failures.push(
			`simpleScore=${metrics.simpleScore.toFixed(3)} < min ${thresholds.minSimpleScore}`,
		);
	}

	return {
		ok: failures.length === 0,
		failures,
		metrics,
		thresholds,
	};
}

// CI fail gate: бросает Error со списком провалов
export function assertRetrievalGate(
	metrics: RetrievalSuiteMetrics,
	thresholds: RetrievalGateThresholds = DEFAULT_RETRIEVAL_GATE,
): void {
	const result = checkRetrievalGate(metrics, thresholds);
	if (!result.ok) {
		const detail = result.failures.join('; ');
		throw new Error(`retrieval eval gate failed: ${detail}`);
	}
}
