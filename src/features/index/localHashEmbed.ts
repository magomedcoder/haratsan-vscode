/**
 * Локальные dense embeddings без модели: feature hashing токенов -> fixed dim.
 * Offline vector index для semantic_search (mode=vector).
 */

const DEFAULT_DIMS = 256;

// FNV-1a 32-bit
function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.filter((t) => t.length >= 2);
}

// L2-нормализация (нулевой вектор -> нули)
export function l2Normalize(vec: number[]): number[] {
	let sum = 0;
	for (const v of vec) {
		sum += v * v;
	}
	if (sum <= 0) {
		return vec.map(() => 0);
	}
	const inv = 1 / Math.sqrt(sum);
	return vec.map((v) => v * inv);
}

/**
 * Захешировать текст в dense vector (signed feature hashing).
 * Детерминированно, без сети / native deps.
 */
export function localHashEmbed(text: string, dims: number = DEFAULT_DIMS): number[] {
	const d = Math.max(8, Math.min(1024, Math.floor(dims) || DEFAULT_DIMS));
	const vec = new Array<number>(d).fill(0);
	const tokens = tokenize(text);
	if (tokens.length === 0) {
		// Запасной путь: char 3-граммы, если нет токенов
		const raw = text.toLowerCase();
		for (let i = 0; i + 2 < raw.length; i += 1) {
			const gram = raw.slice(i, i + 3);
			const h = fnv1a(gram);
			const idx = h % d;
			const sign = (h & 1) === 0 ? 1 : -1;
			vec[idx]! += sign;
		}
		return l2Normalize(vec);
	}

	for (const token of tokens) {
		const h = fnv1a(token);
		const idx = h % d;
		const sign = (h & 1) === 0 ? 1 : -1;
		vec[idx]! += sign;
		// Биграммы соседних токенов усиливают фразы
	}
	for (let i = 0; i + 1 < tokens.length; i += 1) {
		const bigram = `${tokens[i]!}_${tokens[i + 1]!}`;
		const h = fnv1a(bigram);
		const idx = h % d;
		const sign = (h & 1) === 0 ? 1 : -1;
		vec[idx]! += sign * 0.5;
	}

	return l2Normalize(vec);
}

export const LOCAL_HASH_MODEL_ID = 'local-hash-v1';
export const LOCAL_HASH_DIMS = DEFAULT_DIMS;
