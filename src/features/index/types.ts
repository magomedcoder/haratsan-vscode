export const INDEX_MANIFEST_VERSION = 2;
export const INDEX_MANIFEST_VERSIONS_ACCEPTED = new Set([1, 2]);

export interface IndexChunk {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	text: string;
}

export interface IndexFileRecord {
	hash: string;
	size: number;
	chunkIds: string[];
	// mtime из FileStat; быстрый gate перед content-hash (опционально для старых манифестов)
	mtimeMs?: number;
}

export interface IndexManifest {
	version: number;
	updatedAt: string;
	files: Record<string, IndexFileRecord>;
	chunks: Record<string, IndexChunk>;
	trigrams: Record<string, string[]>;
	// Merkle / dir-дайджесты: POSIX-путь -> hash прямых детей (mirror of merkle.json dirs)
	dirDigests: Record<string, string>;
}

export interface CodebaseSearchHit {
	chunkId: string;
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
}

export interface IndexProgress {
	state: 'idle' | 'indexing' | 'ready' | 'error' | 'cancelled';
	fileCount: number;
	chunkCount: number;
	// ISO из manifest.updatedAt после успешной индексации
	updatedAt?: string;
	lastError?: string;
	// Ошибки по отдельным файлам при partial failure (fullIndex не валится целиком)
	partialErrors?: string[];
}

export function emptyManifest(): IndexManifest {
	return {
		version: INDEX_MANIFEST_VERSION,
		updatedAt: new Date(0).toISOString(),
		files: {},
		chunks: {},
		trigrams: {},
		dirDigests: {},
	};
}
