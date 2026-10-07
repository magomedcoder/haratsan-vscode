/**
 * Merkle-дерево v2 для skip индексации и проверки целостности.
 * Хранение: `<storageUri>/index/<folderKey>/merkle.json` `dirDigests` в manifest - совместимый flat-view (корень/каталоги).
 */

import * as fs from 'node:fs/promises';
import { contentHash } from './hash';
import { INDEX_MERKLE_FILE, indexDirForFolder, indexFilePath } from './indexStorage';
import { ancestorDirs, parentDir, recomputeDirDigests } from './dirDigests';
import type { IndexChunk, IndexFileRecord, IndexManifest } from './types';

export const MERKLE_VERSION = 1;
export const MERKLE_ALGORITHM = 'sha256-v2';

export type MerkleNodeKind = 'file' | 'dir';

export interface MerkleNode {
	path: string;
	kind: MerkleNodeKind;
	digest: string;
	// Имена прямых детей (только dir), отсортированы
	children?: string[];
}

export interface MerkleMetrics {
	dirsSkipped: number;
	filesSkipped: number;
	chunksSkipped: number;
	filesIndexed: number;
	chunksIndexed: number;
	dirsTotal: number;
	filesTotal: number;
}

export interface MerkleDocument {
	version: number;
	updatedAt: string;
	algorithm: typeof MERKLE_ALGORITHM;
	nodes: Record<string, MerkleNode>;
	// chunkId -> content-hash текста чанка
	chunkDigests: Record<string, string>;
	// `${path}#${start}-${end}:${name}` -> hash
	symbolDigests: Record<string, string>;
	metrics?: MerkleMetrics;
}

export function emptyMerkle(): MerkleDocument {
	return {
		version: MERKLE_VERSION,
		updatedAt: new Date(0).toISOString(),
		algorithm: MERKLE_ALGORITHM,
		nodes: {},
		chunkDigests: {},
		symbolDigests: {},
	};
}

export function emptyMerkleMetrics(): MerkleMetrics {
	return {
		dirsSkipped: 0,
		filesSkipped: 0,
		chunksSkipped: 0,
		filesIndexed: 0,
		chunksIndexed: 0,
		dirsTotal: 0,
		filesTotal: 0,
	};
}

export function merklePathForFolder(folderFsPath: string): string | undefined {
	return indexFilePath(folderFsPath, INDEX_MERKLE_FILE);
}

export async function loadMerkle(folderFsPath: string): Promise<MerkleDocument> {
	const file = merklePathForFolder(folderFsPath);
	if (!file) {
		return emptyMerkle();
	}

	try {
		const raw = await fs.readFile(file, 'utf8');
		return parseMerkleJson(raw) ?? emptyMerkle();
	} catch {
		return emptyMerkle();
	}
}

export function parseMerkleJson(raw: string): MerkleDocument | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<MerkleDocument>;
		if (!parsed || typeof parsed !== 'object' || parsed.version !== MERKLE_VERSION) {
			return undefined;
		}
		
		if (parsed.algorithm !== MERKLE_ALGORITHM) {
			return undefined;
		}

		return {
			version: MERKLE_VERSION,
			updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
			algorithm: MERKLE_ALGORITHM,
			nodes: parsed.nodes && typeof parsed.nodes === 'object' ? parsed.nodes : {},
			chunkDigests: parsed.chunkDigests && typeof parsed.chunkDigests === 'object' ? parsed.chunkDigests : {},
			symbolDigests: parsed.symbolDigests && typeof parsed.symbolDigests === 'object' ? parsed.symbolDigests : {},
			metrics: parsed.metrics,
		};
	} catch {
		return undefined;
	}
}

export async function saveMerkle(folderFsPath: string, doc: MerkleDocument): Promise<void> {
	const dir = indexDirForFolder(folderFsPath);
	const file = merklePathForFolder(folderFsPath);
	if (!dir || !file) {
		throw new Error('Хранилище индекса недоступно (нет workspace storageUri)');
	}

	await fs.mkdir(dir, { recursive: true });
	doc.updatedAt = new Date().toISOString();
	doc.version = MERKLE_VERSION;
	doc.algorithm = MERKLE_ALGORITHM;
	const tmp = `${file}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(doc), 'utf8');
	await fs.rename(tmp, file);
}

export function chunkContentDigest(text: string): string {
	return contentHash(text);
}

export function symbolLeafKey(path: string, startLine: number, endLine: number, name: string): string {
	return `${path}#${startLine}-${endLine}:${name}`;
}

// Построить дерево узлов из files + опциональных chunk/symbol digests
export function buildMerkleDocument(
	files: Record<string, Pick<IndexFileRecord, 'hash'>>,
	opts?: {
		chunkDigests?: Record<string, string>;
		symbolDigests?: Record<string, string>;
		metrics?: MerkleMetrics;
		prev?: MerkleDocument;
	},
): MerkleDocument {
	const dirDigests = recomputeDirDigests(files);
	const nodes: Record<string, MerkleNode> = {};

	// Имена прямых детей по каталогам
	const childrenByDir = new Map<string, Set<string>>();
	const ensure = (dir: string): Set<string> => {
		let set = childrenByDir.get(dir);
		if (!set) {
			set = new Set();
			childrenByDir.set(dir, set);
		}
		return set;
	};
	ensure('');

	for (const relative of Object.keys(files)) {
		const norm = relative.replace(/\\/g, '/');
		const parts = norm.split('/').filter(Boolean);
		for (let i = 0; i < parts.length; i += 1) {
			const parent = parts.slice(0, i).join('/');
			const name = parts[i]!;
			ensure(parent).add(name);
			if (i < parts.length - 1) {
				ensure(parts.slice(0, i + 1).join('/'));
			}
		}
		nodes[norm] = {
			path: norm,
			kind: 'file',
			digest: files[relative]!.hash,
		};
	}

	for (const [dir, names] of childrenByDir) {
		const sorted = [...names].sort();
		nodes[dir] = {
			path: dir,
			kind: 'dir',
			digest: dirDigests[dir] ?? '',
			children: sorted,
		};
	}

	return {
		version: MERKLE_VERSION,
		updatedAt: new Date().toISOString(),
		algorithm: MERKLE_ALGORITHM,
		nodes,
		chunkDigests: opts?.chunkDigests ?? opts?.prev?.chunkDigests ?? {},
		symbolDigests: opts?.symbolDigests ?? opts?.prev?.symbolDigests ?? {},
		metrics: opts?.metrics,
	};
}

// Синхронизировать flat dirDigests манифеста из Merkle (или пересчитать)
export function syncManifestDirDigests(manifest: IndexManifest, merkle?: MerkleDocument): void {
	if (merkle && Object.keys(merkle.nodes).length > 0) {
		const digests: Record<string, string> = {};
		for (const [pathKey, node] of Object.entries(merkle.nodes)) {
			if (node.kind === 'dir') {
				digests[pathKey] = node.digest;
			}
		}
		manifest.dirDigests = digests;
		return;
	}

	manifest.dirDigests = recomputeDirDigests(manifest.files);
}

export function digestsFromChunks(chunks: Record<string, IndexChunk>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, chunk] of Object.entries(chunks)) {
		out[id] = chunkContentDigest(chunk.text);
	}
	return out;
}

// При reindex файла: сохранить старые чанки с тем же digest (по тексту), вернуть список chunkId которые можно не переэмбеддить
export function mergeChunksPreservingDigests(
	prevChunks: Record<string, IndexChunk>,
	prevDigests: Record<string, string>,
	nextChunks: IndexChunk[],
): {
	chunks: Record<string, IndexChunk>;
	digests: Record<string, string>;
	chunkIds: string[];
	skippedIds: string[];
	indexedIds: string[];
} {
	const byDigest = new Map<string, IndexChunk>();
	for (const [id, chunk] of Object.entries(prevChunks)) {
		const d = prevDigests[id] ?? chunkContentDigest(chunk.text);
		byDigest.set(d, chunk);
	}

	const chunks: Record<string, IndexChunk> = {};
	const digests: Record<string, string> = {};
	const chunkIds: string[] = [];
	const skippedIds: string[] = [];
	const indexedIds: string[] = [];

	for (const chunk of nextChunks) {
		const d = chunkContentDigest(chunk.text);
		const reused = byDigest.get(d);
		if (reused && reused.path === chunk.path) {
			const id = reused.id;
			const merged = { ...chunk, id };
			chunks[id] = merged;
			digests[id] = d;
			chunkIds.push(id);
			skippedIds.push(id);
		} else {
			chunks[chunk.id] = chunk;
			digests[chunk.id] = d;
			chunkIds.push(chunk.id);
			indexedIds.push(chunk.id);
		}
	}

	return { chunks, digests, chunkIds, skippedIds, indexedIds };
}

export function dropPathFromMerkle(
	doc: MerkleDocument,
	relative: string,
	chunkIds: string[],
): MerkleDocument {
	const next = { ...doc, nodes: { ...doc.nodes }, chunkDigests: { ...doc.chunkDigests }, symbolDigests: { ...doc.symbolDigests } };
	delete next.nodes[relative.replace(/\\/g, '/')];
	for (const id of chunkIds) {
		delete next.chunkDigests[id];
	}

	const prefix = `${relative.replace(/\\/g, '/')}#`;
	for (const key of Object.keys(next.symbolDigests)) {
		if (key.startsWith(prefix)) {
			delete next.symbolDigests[key];
		}
	}

	return next;
}

export function detectMerkleIssues(
	manifest: IndexManifest,
	merkle: MerkleDocument,
): { orphans: string[]; mismatches: string[]; missingNodes: string[] } {
	const orphans: string[] = [];
	const mismatches: string[] = [];
	const missingNodes: string[] = [];

	for (const [rel, record] of Object.entries(manifest.files)) {
		const node = merkle.nodes[rel.replace(/\\/g, '/')];
		if (!node || node.kind !== 'file') {
			missingNodes.push(rel);
			continue;
		}
		
		if (node.digest !== record.hash) {
			mismatches.push(rel);
		}

		for (const id of record.chunkIds) {
			if (!manifest.chunks[id]) {
				orphans.push(id);
			} else if (!merkle.chunkDigests[id]) {
				orphans.push(`digest:${id}`);
			}
		}
	}

	for (const id of Object.keys(merkle.chunkDigests)) {
		if (!manifest.chunks[id]) {
			orphans.push(id);
		}
	}

	return { orphans, mismatches, missingNodes };
}

export function repairMerkleFromManifest(
	manifest: IndexManifest,
	prev?: MerkleDocument,
	metrics?: MerkleMetrics,
): MerkleDocument {
	const chunkDigests = digestsFromChunks(manifest.chunks);
	// Сохранить symbol digests для путей, которые ещё есть в манифесте
	const symbolDigests: Record<string, string> = {};
	if (prev) {
		for (const [key, digest] of Object.entries(prev.symbolDigests)) {
			const pathPart = key.split('#')[0] ?? '';
			if (manifest.files[pathPart]) {
				symbolDigests[key] = digest;
			}
		}
	}
	return buildMerkleDocument(manifest.files, { chunkDigests, symbolDigests, metrics, prev });
}

export { parentDir, ancestorDirs };
