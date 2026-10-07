import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import { getApiKey, buildAuthHeaders } from '../../core/config/apiKey';
import { getIndexManagerInstance } from './IndexManager';
import { LOCAL_HASH_DIMS, LOCAL_HASH_MODEL_ID, localHashEmbed } from './localHashEmbed';
import { loadManifest } from './store';
import { cosineSimilarity, hashChunkText, loadVectorIndex, saveVectorIndex, searchVectorIndex, syncLocalHashVectors, upsertRemoteVectors } from './vectorStore';
import type { IndexChunk } from './types';

export interface EmbeddingHit {
	path: string;
	score: number;
	snippet?: string;
	source?: 'remote' | 'trigram' | 'local-vector';
}

const EMBED_BATCH_SIZE = 32;
const EMBED_MAX_RETRIES = 3;
const EMBED_TIMEOUT_MS = 45_000;
const MAX_CHUNK_EMBED_CHARS = 1200;
const MAX_REMOTE_CHUNKS = 200;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			const err = new Error('AbortError');
			err.name = 'AbortError';
			reject(err);
			return;
		}

		const t = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(t);
			const err = new Error('AbortError');
			err.name = 'AbortError';
			reject(err);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
	if (!a && !b) {
		return undefined;
	}

	if (a && !b) {
		return a;
	}

	if (b && !a) {
		return b;
	}

	const merged = new AbortController();
	const onAbort = () => merged.abort();
	a!.addEventListener('abort', onAbort, { once: true });
	b!.addEventListener('abort', onAbort, { once: true });
	if (a!.aborted || b!.aborted) {
		merged.abort();
	}

	return merged.signal;
}

async function fetchEmbeddingsOnce(
	base: string,
	model: string,
	texts: string[],
	signal?: AbortSignal,
): Promise<number[][]> {
	const settings = getSettings();
	const apiKey = await getApiKey();
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...buildAuthHeaders(apiKey, settings.authHeader, settings.authScheme),
	};
	const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
	const combined = combineAbortSignals(signal, timeout);
	const res = await fetch(`${base}/embeddings`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			model,
			input: texts,
		}),
		signal: combined,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		const hint = body.slice(0, 160).replace(/\s+/g, ' ');
		throw new Error(
			`embeddings HTTP ${res.status}${hint ? `: ${hint}` : ''}`,
		);
	}

	const json = (await res.json()) as {
		data?: Array<{ embedding?: number[]; index?: number }>;
		error?: { message?: string };
	};
	if (json.error?.message) {
		throw new Error(json.error.message);
	}

	const data = json.data ?? [];
	// OpenAI иногда возвращает data не по порядку - сортируем по index
	const ordered = [...data].sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
	const vectors = ordered.map((d) => d.embedding ?? []);
	if (vectors.length !== texts.length) {
		throw new Error(
			`embeddings: неожиданная длина ответа (${vectors.length} != ${texts.length})`,
		);
	}

	return vectors;
}

/**
 * Удалённый OpenAI-compatible POST /embeddings.
 * Батчи + retry с backoff + timeout.
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
	const settings = getSettings();
	const base = (settings.embeddingsBaseUrl || settings.baseUrl).replace(/\/$/, '');
	const model = settings.embeddingsModel || 'text-embedding-3-small';
	if (!base) {
		throw new Error('embeddings: не задан baseUrl / embeddingsBaseUrl');
	}

	if (texts.length === 0) {
		return [];
	}

	const out: number[][] = new Array(texts.length);
	for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
		signal?.throwIfAborted();
		const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
		let lastErr: unknown;
		for (let attempt = 0; attempt < EMBED_MAX_RETRIES; attempt += 1) {
			try {
				const vectors = await fetchEmbeddingsOnce(base, model, batch, signal);
				for (let i = 0; i < vectors.length; i += 1) {
					out[start + i] = vectors[i]!;
				}

				lastErr = undefined;
				break;
			} catch (err) {
				lastErr = err;
				if (err instanceof Error && err.name === 'AbortError') {
					throw err;
				}

				const statusMatch = err instanceof Error && /HTTP (429|5\d\d)/.test(err.message);
				if (!statusMatch && attempt > 0) {
					// Не повторять после первой попытки (4xx кроме 429)
					break;
				}

				await sleep(200 * 2 ** attempt, signal);
			}
		}
		if (lastErr) {
			throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
		}
	}

	return out as number[][];
}

function remoteEmbeddingsUnavailable(): boolean {
	const settings = getSettings();
	const base = (settings.embeddingsBaseUrl || settings.baseUrl).replace(/\/$/, '');
	return !base;
}

function embeddingsModelId(): string {
	return getSettings().embeddingsModel || 'text-embedding-3-small';
}

// Offline semantic-путь: поиск триграмм IndexManager
export async function trigramSemanticFallback(
	query: string,
	maxResults: number,
): Promise<EmbeddingHit[]> {
	const manager = getIndexManagerInstance();
	if (!manager) {
		return [];
	}

	const hits = await manager.search(query, maxResults);
	const maxScore = Math.max(1, ...hits.map((h) => h.score), 1);
	return hits.map((h) => ({
		path: h.path,
		score: Math.min(1, h.score / maxScore),
		snippet: h.snippet.slice(0, 240),
		source: 'trigram' as const,
	}));
}

// Локальный vector index (feature hashing) - без remote
export async function localVectorSemanticSearch(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<EmbeddingHit[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}
	
	signal?.throwIfAborted();
	const folderFs = folder.uri.fsPath;
	const manifest = await loadManifest(folderFs);
	let index = await loadVectorIndex(folderFs);
	const hasLocal = Object.values(index.entries).some((e) => e.source === 'local-hash');
	if (!hasLocal || Object.keys(manifest.chunks).length === 0) {
		if (Object.keys(manifest.chunks).length === 0) {
			return [];
		}

		index = syncLocalHashVectors(manifest, index);
		await saveVectorIndex(folderFs, index);
	}

	const qVec = localHashEmbed(query, LOCAL_HASH_DIMS);
	const hits = searchVectorIndex(index, qVec, {
		maxResults,
		model: LOCAL_HASH_MODEL_ID,
		source: 'local-hash',
	});
	return hits.map((h) => ({
		path: h.path,
		score: h.score,
		snippet: h.snippet,
		source: 'local-vector' as const,
	}));
}

function pickChunksForRemote(manifestChunks: Record<string, IndexChunk>): IndexChunk[] {
	const all = Object.values(manifestChunks);
	if (all.length === 0) {
		return [];
	}

	// Предпочитаем разнообразные пути; лимит MAX_REMOTE_CHUNKS
	const byPath = new Map<string, IndexChunk[]>();
	for (const c of all) {
		const list = byPath.get(c.path) ?? [];
		list.push(c);
		byPath.set(c.path, list);
	}

	const picked: IndexChunk[] = [];
	const paths = [...byPath.keys()].sort();
	let round = 0;
	while (picked.length < MAX_REMOTE_CHUNKS) {
		let added = false;
		for (const p of paths) {
			const list = byPath.get(p)!;
			if (round < list.length) {
				picked.push(list[round]!);
				added = true;
				if (picked.length >= MAX_REMOTE_CHUNKS) {
					break;
				}
			}
		}

		if (!added) {
			break;
		}

		round += 1;
	}

	return picked;
}

/**
 * Стабильный remote search: кэш векторов по content-hash в workspace storage vectors.json.
 * Query эмбеддится каждый раз; документы - из кэша или доэмбеддятся батчами.
 */
async function remoteSemanticSearchWorkspace(
	query: string,
	opts?: { maxFiles?: number; maxResults?: number; signal?: AbortSignal },
): Promise<EmbeddingHit[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const maxResults = opts?.maxResults ?? 8;
	const folderFs = folder.uri.fsPath;
	const model = embeddingsModelId();
	const manifest = await loadManifest(folderFs);
	let vectorIndex = await loadVectorIndex(folderFs);

	let chunks = pickChunksForRemote(manifest.chunks);

	// Запасной путь: нет индекса - ad-hoc sample файлов (как раньше, но с кэшем)
	if (chunks.length === 0) {
		const maxFiles = opts?.maxFiles ?? 40;
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, '**/*.{ts,tsx,js,jsx,py,go,rs,md}'),
			'**/{node_modules,.git,.haratsan,dist,out}/**',
			maxFiles,
		);
		chunks = [];
		for (const uri of uris) {
			opts?.signal?.throwIfAborted();
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				const text = new TextDecoder().decode(bytes).slice(0, MAX_CHUNK_EMBED_CHARS);
				if (!text.trim()) {
					continue;
				}

				const rel = vscode.workspace.asRelativePath(uri);
				chunks.push({
					id: `adhoc:${rel}`,
					path: rel,
					startLine: 1,
					endLine: 1,
					text,
				});
			} catch {
				continue;
			}
		}
	}

	if (chunks.length === 0) {
		return [];
	}

	const missing: IndexChunk[] = [];
	const contentHashes = new Map<string, string>();
	for (const chunk of chunks) {
		const fileHash = manifest.files[chunk.path]?.hash;
		const contentHash = fileHash ?? hashChunkText(chunk.text);
		contentHashes.set(chunk.id, contentHash);
		const key = `${model}:${contentHash}:${chunk.id}`;
		const cached = vectorIndex.entries[key];
		if (!cached || cached.source !== 'remote' || cached.vector.length === 0) {
			missing.push(chunk);
		}
	}

	if (missing.length > 0) {
		const texts = missing.map((c) => c.text.slice(0, MAX_CHUNK_EMBED_CHARS));
		const vectors = await embedTexts(texts, opts?.signal);
		vectorIndex = upsertRemoteVectors(
			vectorIndex,
			missing.map((chunk, i) => ({
				chunk,
				contentHash: contentHashes.get(chunk.id) ?? hashChunkText(chunk.text),
				model,
				vector: vectors[i]!,
			})),
		);
		await saveVectorIndex(folderFs, vectorIndex);
	}

	const [qVec] = await embedTexts([query], opts?.signal);
	const hits = searchVectorIndex(vectorIndex, qVec!, {
		maxResults,
		model,
		source: 'remote',
	});

	// Если кэш шире текущего sample - фильтруем только выбранные id чанков
	const allow = new Set(chunks.map((c) => c.id));
	const filtered = hits.filter((h) => allow.has(h.chunkId) || h.chunkId.startsWith('adhoc:'));
	const use = filtered.length > 0 ? filtered : hits;
	return use.map((h) => ({
		path: h.path,
		score: h.score,
		snippet: h.snippet,
		source: 'remote' as const,
	}));
}

/**
 * Семантический поиск с localEmbeddingsMode:
 * - off: только remote (+ persistent vector cache)
 * - trigram: remote при наличии; fallback на триграммы
 * - vector: локальный dense index (feature hashing), без сети
 */
export async function semanticSearchWorkspace(
	query: string,
	opts?: { maxFiles?: number; maxResults?: number; signal?: AbortSignal },
): Promise<EmbeddingHit[]> {
	const settings = getSettings();
	const mode = settings.localEmbeddingsMode;
	const maxResults = opts?.maxResults ?? 8;
	const unavailable = remoteEmbeddingsUnavailable();

	if (mode === 'vector') {
		const local = await localVectorSemanticSearch(query, maxResults, opts?.signal);
		if (local.length > 0) {
			return local;
		}

		// Пустой vector index -> trigram как последний запасной путь
		return trigramSemanticFallback(query, maxResults);
	}

	if (mode === 'off') {
		if (unavailable) {
			throw new Error(
				'semantic_search: удалённые embeddings недоступны (localEmbeddingsMode=off)',
			);
		}

		return remoteSemanticSearchWorkspace(query, opts);
	}

	// trigram (default): пробуем remote при URL, иначе / при сбое -> trigram
	if (!unavailable) {
		try {
			return await remoteSemanticSearchWorkspace(query, opts);
		} catch {
			// дальше
		}
	}

	// Перед trigram - попробовать локальный vector, если уже построен
	try {
		const local = await localVectorSemanticSearch(query, maxResults, opts?.signal);
		if (local.length > 0 && local[0]!.score > 0.05) {
			return local;
		}
	} catch {}

	const local = await trigramSemanticFallback(query, maxResults);
	if (local.length === 0 && unavailable) {
		throw new Error(
			'semantic_search: удалённые embeddings недоступны; trigram/vector индекс пуст или не готов',
		);
	}

	return local;
}

// Пересобрать local-hash векторы после индексации (вызывается из IndexManager)
export async function rebuildLocalVectorIndex(
	folderFsPath: string,
	opts?: { onlyChunkIds?: ReadonlyArray<string> },
): Promise<number> {
	const manifest = await loadManifest(folderFsPath);
	const prev = await loadVectorIndex(folderFsPath);
	const only = opts?.onlyChunkIds?.length ? new Set(opts.onlyChunkIds) : undefined;
	const next = syncLocalHashVectors(manifest, prev, only ? { onlyChunkIds: only } : undefined);
	await saveVectorIndex(folderFsPath, next);
	return Object.values(next.entries).filter((e) => e.source === 'local-hash').length;
}

// Re-export для тестов
export { cosineSimilarity };
