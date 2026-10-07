import type { IndexChunk } from './types';
import type { TreeSitterSpan } from './treeSitter';

export const CHUNK_LIMITS = {
	maxChunkLines: 120,
	minChunkLines: 6,
	maxChunkChars: 6_000,
	maxChunksPerFile: 80,
} as const;

const SYMBOL_START = /^(export\s+)?(async\s+)?(function\s+\w|class\s+\w|interface\s+\w|type\s+\w|enum\s+\w|const\s+\w+\s*=|let\s+\w+\s*=|def\s+\w|func\s+\(|fn\s+\w|impl\s+|pub\s+(async\s+)?fn\s+)/;

function chunkId(path: string, startLine: number, endLine: number): string {
	return `${path}#${startLine}-${endLine}`;
}

// Стабильный id по содержимому чанка - переживает сдвиг соседних символов
export function contentChunkId(path: string, text: string): string {
	let h = 0;
	for (let i = 0; i < text.length; i += 1) {
		h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
	}

	const hex = (h >>> 0).toString(16).padStart(8, '0');
	return `${path}#c${hex}`;
}

function pushChunk(out: IndexChunk[], path: string, lines: string[], startLine: number, useContentId = false): void {
	if (lines.length === 0) {
		return;
	}

	const text = lines.join('\n').trimEnd();
	if (!text.trim()) {
		return;
	}

	const endLine = startLine + lines.length - 1;
	out.push({
		id: useContentId ? contentChunkId(path, text) : chunkId(path, startLine, endLine),
		path,
		startLine,
		endLine,
		text,
	});
}

function splitOversized(path: string, lines: string[], startLine: number, out: IndexChunk[], useContentId: boolean): void {
	let cursor = 0;
	while (cursor < lines.length) {
		const slice = lines.slice(cursor, cursor + CHUNK_LIMITS.maxChunkLines);
		pushChunk(out, path, slice, startLine + cursor, useContentId);
		cursor += CHUNK_LIMITS.maxChunkLines;
	}
}

function flushBlock(
	out: IndexChunk[],
	path: string,
	block: string[],
	blockStart: number,
	useContentId: boolean,
): void {
	if (block.length === 0) {
		return;
	}

	const joined = block.join('\n');
	if (joined.length > CHUNK_LIMITS.maxChunkChars || block.length > CHUNK_LIMITS.maxChunkLines) {
		splitOversized(path, block, blockStart, out, useContentId);
	} else {
		pushChunk(out, path, block, blockStart, useContentId);
	}
}

// Эвристическая нарезка: границы символов + лимиты по строкам/символам
export function chunkFileContent(relativePath: string, content: string): IndexChunk[] {
	const lines = content.split(/\r?\n/);
	const out: IndexChunk[] = [];
	let block: string[] = [];
	let blockStart = 1;

	const flush = (): void => {
		flushBlock(out, relativePath, block, blockStart, false);
		block = [];
	};

	for (let i = 0; i < lines.length; i += 1) {
		const lineNo = i + 1;
		const line = lines[i];

		if (block.length > 0 && SYMBOL_START.test(line.trim()) && block.length >= CHUNK_LIMITS.minChunkLines) {
			flush();
		}

		if (block.length === 0) {
			blockStart = lineNo;
		}

		block.push(line);

		if (block.length >= CHUNK_LIMITS.maxChunkLines) {
			flush();
		}
	}

	flush();

	if (out.length > CHUNK_LIMITS.maxChunksPerFile) {
		return out.slice(0, CHUNK_LIMITS.maxChunksPerFile);
	}

	return out;
}

/**
 * AST-aware chunking: один чанк на span (function/class/...); промежутки - line-window.
 * Chunk id = content-hash based для стабильности при правках соседних символов.
 */
export function chunkFileContentAst(
	relativePath: string,
	content: string,
	spans: TreeSitterSpan[],
): IndexChunk[] {
	const lines = content.split(/\r?\n/);
	const total = lines.length;
	if (total === 0) {
		return [];
	}

	// Ближе к top-level: длиннее/внешние; вложенные отбрасываем, если родитель покрывает
	const sorted = [...spans].filter((s) => s.endLine >= s.startLine && s.startLine >= 1 && s.endLine <= total)
		.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);

	const picked: TreeSitterSpan[] = [];
	for (const s of sorted) {
		const nested = picked.some((p) => s.startLine >= p.startLine && s.endLine <= p.endLine);
		if (nested) {
			continue;
		}

		picked.push(s);
	}

	const covered = new Array<boolean>(total + 1).fill(false);
	const out: IndexChunk[] = [];

	for (const s of picked) {
		if (out.length >= CHUNK_LIMITS.maxChunksPerFile) {
			break;
		}

		const slice = lines.slice(s.startLine - 1, s.endLine);
		flushBlock(out, relativePath, slice, s.startLine, true);
		for (let ln = s.startLine; ln <= s.endLine; ln += 1) {
			covered[ln] = true;
		}
	}

	// Промежутки между span - line-window
	let gapStart: number | undefined;
	const flushGap = (endInclusive: number): void => {
		if (gapStart === undefined) {
			return;
		}

		const slice = lines.slice(gapStart - 1, endInclusive);
		if (slice.some((l) => l.trim())) {
			flushBlock(out, relativePath, slice, gapStart, true);
		}
		gapStart = undefined;
	};

	for (let ln = 1; ln <= total; ln += 1) {
		if (covered[ln]) {
			flushGap(ln - 1);
			continue;
		}

		if (gapStart === undefined) {
			gapStart = ln;
		}

		if (ln - gapStart + 1 >= CHUNK_LIMITS.maxChunkLines) {
			flushGap(ln);
		}
	}
	flushGap(total);

	if (out.length === 0) {
		return chunkFileContent(relativePath, content);
	}

	if (out.length > CHUNK_LIMITS.maxChunksPerFile) {
		return out.slice(0, CHUNK_LIMITS.maxChunksPerFile);
	}
	
	return out;
}
