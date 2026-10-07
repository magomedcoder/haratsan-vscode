import type { HaratsanSettings } from '../../core/config/types';
import { isTreeSitterAvailable, resolveTreeSitterLang } from './treeSitter';

export type OutlineEngine = 'auto' | 'treesitter' | 'lsp' | 'typescript';
export type ChunkEngine = 'auto' | 'treesitter' | 'lines';

export function normalizeOutlineEngine(raw: unknown): OutlineEngine {
	const v = String(raw ?? '').trim().toLowerCase();
	if (v === 'treesitter' || v === 'lsp' || v === 'typescript' || v === 'auto') {
		return v;
	}

	return 'auto';
}

export function normalizeChunkEngine(raw: unknown): ChunkEngine {
	const v = String(raw ?? '').trim().toLowerCase();
	if (v === 'treesitter' || v === 'lines' || v === 'auto') {
		return v;
	}
	return 'auto';
}

// Пробовать Tree-sitter для outline по этому пути
export function shouldUseTreeSitterOutline(
	settings: Pick<HaratsanSettings, 'outlineEngine'>,
	relativePath: string,
): boolean {
	const eng = settings.outlineEngine ?? 'auto';
	if (eng === 'lsp' || eng === 'typescript') {
		return false;
	}
	
	if (eng === 'treesitter') {
		return isTreeSitterAvailable() && Boolean(resolveTreeSitterLang(relativePath));
	}

	// auto
	return isTreeSitterAvailable() && Boolean(resolveTreeSitterLang(relativePath));
}

// Пробовать AST-нарезку чанков через Tree-sitter
export function shouldUseTreeSitterChunk(
	settings: Pick<HaratsanSettings, 'chunkEngine'>,
	relativePath: string,
): boolean {
	const eng = settings.chunkEngine ?? 'auto';
	if (eng === 'lines') {
		return false;
	}

	if (eng === 'treesitter') {
		return isTreeSitterAvailable() && Boolean(resolveTreeSitterLang(relativePath));
	}
	
	return isTreeSitterAvailable() && Boolean(resolveTreeSitterLang(relativePath));
}
