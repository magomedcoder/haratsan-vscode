import type { IndexChunk, IndexManifest } from './types';

const MIN_TOKEN_LEN = 3;

function normalize(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}_./-]+/gu, ' ');
}

export function tokenize(text: string): string[] {
	const normalized = normalize(text);
	const raw = normalized.split(/\s+/).filter((t) => t.length >= MIN_TOKEN_LEN);
	const grams: string[] = [];

	for (const token of raw) {
		if (token.length <= MIN_TOKEN_LEN) {
			grams.push(token);
			continue;
		}

		for (let i = 0; i <= token.length - MIN_TOKEN_LEN; i += 1) {
			grams.push(token.slice(i, i + MIN_TOKEN_LEN));
		}
	}

	return grams;
}

export function buildTrigramIndex(chunks: readonly IndexChunk[]): Record<string, string[]> {
	const map = new Map<string, Set<string>>();

	for (const chunk of chunks) {
		const grams = new Set(tokenize(`${chunk.path} ${chunk.text}`));
		for (const gram of grams) {
			let set = map.get(gram);
			if (!set) {
				set = new Set();
				map.set(gram, set);
			}

			set.add(chunk.id);
		}
	}

	const out: Record<string, string[]> = {};
	for (const [gram, ids] of map) {
		out[gram] = [...ids];
	}

	return out;
}

export function rebuildManifestTrigrams(manifest: IndexManifest): void {
	manifest.trigrams = buildTrigramIndex(Object.values(manifest.chunks));
}

/**
 * Инкремент: убрать id из inverted index и добавить граммы только для `addChunks`.
 * Если `fullRebuild` или trigrams пусты - полный rebuild.
 */
export function patchManifestTrigrams(
	manifest: IndexManifest,
	opts: {
		removedChunkIds: ReadonlyArray<string>;
		addChunks: ReadonlyArray<IndexChunk>;
		fullRebuild?: boolean;
	},
): void {
	if (opts.fullRebuild || !manifest.trigrams || Object.keys(manifest.trigrams).length === 0) {
		rebuildManifestTrigrams(manifest);
		return;
	}

	const remove = new Set(opts.removedChunkIds);
	if (remove.size > 0) {
		for (const [gram, ids] of Object.entries(manifest.trigrams)) {
			const next = ids.filter((id) => !remove.has(id));
			if (next.length === 0) {
				delete manifest.trigrams[gram];
			} else {
				manifest.trigrams[gram] = next;
			}
		}
	}

	for (const chunk of opts.addChunks) {
		const grams = new Set(tokenize(`${chunk.path} ${chunk.text}`));
		for (const gram of grams) {
			const list = manifest.trigrams[gram] ?? [];
			if (!list.includes(chunk.id)) {
				list.push(chunk.id);
			}
			
			manifest.trigrams[gram] = list;
		}
	}
}

export interface TrigramSearchHit {
	chunkId: string;
	score: number;
}

export function searchTrigrams(manifest: IndexManifest, query: string, cap: number): TrigramSearchHit[] {
	const grams = tokenize(query);
	if (grams.length === 0) {
		return [];
	}

	const scores = new Map<string, number>();
	for (const gram of grams) {
		const ids = manifest.trigrams[gram];
		if (!ids) {
			continue;
		}

		for (const id of ids) {
			scores.set(id, (scores.get(id) ?? 0) + 1);
		}
	}

	return [...scores.entries()].sort((a, b) => b[1] - a[1])
		.slice(0, cap)
		.map(([chunkId, score]) => ({ chunkId, score }));
}
