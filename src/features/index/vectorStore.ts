/**
 * Персистентный векторный индекс в workspace storage (`.../index/<key>/vectors.json`).
 * Ключ: content hash чанка + model id (remote или local-hash).
 */

import * as fs from 'node:fs/promises';
import { INDEX_VECTORS_FILE, indexDirForFolder, indexFilePath } from './indexStorage';
import type { IndexChunk, IndexManifest } from './types';
import { LOCAL_HASH_DIMS, LOCAL_HASH_MODEL_ID, localHashEmbed } from './localHashEmbed';

const VECTORS_VERSION = 1;

export type VectorSource = 'remote' | 'local-hash';

export interface VectorEntry {
	chunkId: string;
	path: string;
	// Content hash файла (из manifest.files) или hash текста чанка
	contentHash: string;
	model: string;
	source: VectorSource;
	dims: number;
	vector: number[];
	snippet?: string;
}

export interface VectorIndexFile {
	version: number;
	updatedAt: string;
	entries: Record<string, VectorEntry>;
}

function vectorsPathForFolder(folderFsPath: string): string | undefined {
	return indexFilePath(folderFsPath, INDEX_VECTORS_FILE);
}

export function vectorEntryKey(contentHash: string, model: string, chunkId: string): string {
	return `${model}:${contentHash}:${chunkId}`;
}

export function emptyVectorIndex(): VectorIndexFile {
	return {
		version: VECTORS_VERSION,
		updatedAt: new Date(0).toISOString(),
		entries: {},
	};
}

export async function loadVectorIndex(folderFsPath: string): Promise<VectorIndexFile> {
	const file = vectorsPathForFolder(folderFsPath);
	if (!file) {
		return emptyVectorIndex();
	}

	try {
		const raw = await fs.readFile(file, 'utf8');
		const parsed = JSON.parse(raw) as VectorIndexFile;
		if (!parsed || typeof parsed !== 'object' || parsed.version !== VECTORS_VERSION) {
			return emptyVectorIndex();
		}

		if (!parsed.entries || typeof parsed.entries !== 'object') {
			return emptyVectorIndex();
		}

		return parsed;
	} catch {
		return emptyVectorIndex();
	}
}

export async function saveVectorIndex(folderFsPath: string, index: VectorIndexFile): Promise<void> {
	const dir = indexDirForFolder(folderFsPath);
	const file = vectorsPathForFolder(folderFsPath);
	if (!dir || !file) {
		throw new Error('Хранилище индекса недоступно (нет workspace storageUri)');
	}

	await fs.mkdir(dir, { recursive: true });
	index.updatedAt = new Date().toISOString();
	index.version = VECTORS_VERSION;
	const tmp = `${file}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(index), 'utf8');
	await fs.rename(tmp, file);
}

export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i += 1) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}

	if (na === 0 || nb === 0) {
		return 0;
	}

	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Простой content-hash текста чанка (FNV-ish hex)
export function hashChunkText(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}

	return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Построить / обновить local-hash векторы.
 * `onlyChunkIds` - переэмбеддить только эти id; остальные reuse из prev (если vector жив).
 */
export function syncLocalHashVectors(
	manifest: IndexManifest,
	prev: VectorIndexFile,
	opts?: { onlyChunkIds?: ReadonlySet<string> },
): VectorIndexFile {
	const next = emptyVectorIndex();
	const model = LOCAL_HASH_MODEL_ID;
	const keepRemote = Object.entries(prev.entries).filter(([, e]) => e.source === 'remote');
	const only = opts?.onlyChunkIds;
	const prevByChunk = new Map<string, VectorIndexFile['entries'][string]>();
	for (const e of Object.values(prev.entries)) {
		if (e.source === 'local-hash' && e.vector.length === LOCAL_HASH_DIMS) {
			prevByChunk.set(e.chunkId, e);
		}
	}

	for (const [chunkId, chunk] of Object.entries(manifest.chunks)) {
		const fileRec = manifest.files[chunk.path];
		const ch = fileRec?.hash ?? hashChunkText(chunk.text);
		const key = vectorEntryKey(ch, model, chunkId);
		const existing = prev.entries[key];
		const mustReembed = !only || only.has(chunkId);

		if (
			existing &&
			existing.source === 'local-hash' &&
			existing.contentHash === ch &&
			existing.vector.length === LOCAL_HASH_DIMS
		) {
			next.entries[key] = existing;
			continue;
		}

		if (!mustReembed) {
			const reused = prevByChunk.get(chunkId);
			if (reused) {
				next.entries[key] = {
					...reused,
					chunkId,
					path: chunk.path,
					contentHash: ch,
					model,
				};
				continue;
			}
		}

		next.entries[key] = {
			chunkId,
			path: chunk.path,
			contentHash: ch,
			model,
			source: 'local-hash',
			dims: LOCAL_HASH_DIMS,
			vector: localHashEmbed(chunk.text, LOCAL_HASH_DIMS),
			snippet: chunk.text.slice(0, 240),
		};
	}

	const liveChunkIds = new Set(Object.keys(manifest.chunks));
	for (const [key, entry] of keepRemote) {
		if (liveChunkIds.has(entry.chunkId)) {
			next.entries[key] = entry;
		}
	}

	return next;
}

export interface VectorSearchHit {
	chunkId: string;
	path: string;
	score: number;
	snippet?: string;
	source: VectorSource;
}

// Cosine-поиск по индексу (фильтр по model опционален)
export function searchVectorIndex(
	index: VectorIndexFile,
	queryVec: number[],
	opts?: { maxResults?: number; model?: string; source?: VectorSource },
): VectorSearchHit[] {
	const maxResults = opts?.maxResults ?? 8;
	const scored: VectorSearchHit[] = [];
	for (const entry of Object.values(index.entries)) {
		if (opts?.model && entry.model !== opts.model) {
			continue;
		}

		if (opts?.source && entry.source !== opts.source) {
			continue;
		}

		scored.push({
			chunkId: entry.chunkId,
			path: entry.path,
			score: cosineSimilarity(queryVec, entry.vector),
			snippet: entry.snippet,
			source: entry.source,
		});
	}
	scored.sort((a, b) => b.score - a.score);
	// Дедуп по path: лучший чанк
	const best = new Map<string, VectorSearchHit>();
	for (const hit of scored) {
		const prev = best.get(hit.path);
		if (!prev || hit.score > prev.score) {
			best.set(hit.path, hit);
		}
	}

	return [...best.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
}

// Обновить/вставить remote-векторы для чанков
export function upsertRemoteVectors(
	index: VectorIndexFile,
	items: Array<{
		chunk: IndexChunk;
		contentHash: string;
		model: string;
		vector: number[];
	}>,
): VectorIndexFile {
	const next: VectorIndexFile = {
		version: VECTORS_VERSION,
		updatedAt: index.updatedAt,
		entries: { ...index.entries },
	};
	for (const item of items) {
		const key = vectorEntryKey(item.contentHash, item.model, item.chunk.id);
		next.entries[key] = {
			chunkId: item.chunk.id,
			path: item.chunk.path,
			contentHash: item.contentHash,
			model: item.model,
			source: 'remote',
			dims: item.vector.length,
			vector: item.vector,
			snippet: item.chunk.text.slice(0, 240),
		};
	}
	return next;
}
