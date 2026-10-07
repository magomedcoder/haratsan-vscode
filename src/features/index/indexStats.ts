/**
 * Метрики индексации: AST vs lines чанки, outline по source, % пропуска Merkle
 */

export interface IndexRunStats {
	filesAstChunked: number;
	filesLineChunked: number;
	outlineBySource: Record<string, number>;
	lastMerkle?: {
		filesSkipped: number;
		filesTotal: number;
		chunksSkipped: number;
		chunksIndexed: number;
		dirsSkipped: number;
		dirsTotal: number;
	};
	updatedAt: string;
}

const byFolder = new Map<string, IndexRunStats>();

export function emptyIndexRunStats(): IndexRunStats {
	return {
		filesAstChunked: 0,
		filesLineChunked: 0,
		outlineBySource: {},
		updatedAt: new Date(0).toISOString(),
	};
}

export function getIndexRunStats(folderFsPath: string): IndexRunStats {
	return byFolder.get(folderFsPath) ?? emptyIndexRunStats();
}

export function recordChunkEngineUse(
	folderFsPath: string,
	engine: 'ast' | 'lines',
): void {
	const cur = { ...getIndexRunStats(folderFsPath) };
	if (engine === 'ast') {
		cur.filesAstChunked += 1;
	} else {
		cur.filesLineChunked += 1;
	}

	cur.updatedAt = new Date().toISOString();
	byFolder.set(folderFsPath, cur);
}

export function recordOutlineBreakdown(
	folderFsPath: string,
	bySource: Record<string, number>,
): void {
	const cur = { 
		...getIndexRunStats(folderFsPath) 
	};
	cur.outlineBySource = { ...bySource };
	cur.updatedAt = new Date().toISOString();
	byFolder.set(folderFsPath, cur);
}

export function recordMerkleSkipStats(
	folderFsPath: string,
	metrics: NonNullable<IndexRunStats['lastMerkle']>,
): void {
	const cur = { 
		...getIndexRunStats(folderFsPath) 
	};
	cur.lastMerkle = { ...metrics };
	cur.updatedAt = new Date().toISOString();
	byFolder.set(folderFsPath, cur);
}

export function resetIndexRunStats(folderFsPath: string): void {
	byFolder.set(folderFsPath, emptyIndexRunStats());
}

export function astChunkRatio(stats: IndexRunStats): number | undefined {
	const total = stats.filesAstChunked + stats.filesLineChunked;
	if (total <= 0) {
		return undefined;
	}
	
	return stats.filesAstChunked / total;
}
