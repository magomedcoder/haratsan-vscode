import type { HaratsanSettings } from '../../core/config/types';
import { isTreeSitterAvailable, resolveTreeSitterLang, setTreeSitterLanguageAllowlist, setTreeSitterUseWorker } from './treeSitter';

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

// Применить настройки языков / worker к runtime Tree-sitter
export function applyTreeSitterSettings(
	settings: Pick<HaratsanSettings, 'treeSitterLanguages' | 'treeSitterUseWorker'>,
): void {
	setTreeSitterLanguageAllowlist(settings.treeSitterLanguages);
	setTreeSitterUseWorker(settings.treeSitterUseWorker === true);
}

export function shouldUseTreeSitterOutline(
	settings: Pick<HaratsanSettings, 'outlineEngine' | 'treeSitterLanguages' | 'treeSitterUseWorker'>,
	relativePath: string,
): boolean {
	applyTreeSitterSettings(settings);
	const eng = settings.outlineEngine ?? 'auto';
	if (eng === 'lsp' || eng === 'typescript') {
		return false;
	}
	return isTreeSitterAvailable() && Boolean(resolveTreeSitterLang(relativePath));
}

export function shouldUseTreeSitterChunk(
	settings: Pick<HaratsanSettings, 'chunkEngine' | 'treeSitterLanguages' | 'treeSitterUseWorker'>,
	relativePath: string,
): boolean {
	applyTreeSitterSettings(settings);
	const eng = settings.chunkEngine ?? 'auto';
	if (eng === 'lines') {
		return false;
	}
	return isTreeSitterAvailable() && Boolean(resolveTreeSitterLang(relativePath));
}
