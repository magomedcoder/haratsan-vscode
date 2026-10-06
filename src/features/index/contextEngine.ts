import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import { AGENT_LIMITS, looksBinary } from '../agent/policy';
import { getIndexManager } from './IndexManager';
import type { CodebaseSearchHit } from './types';

export interface ContextHit {
	source: 'codebase' | 'editor' | 'file' | 'folder';
	path: string;
	startLine?: number;
	endLine?: number;
	score: number;
	snippet: string;
}

export interface ContextPack {
	hits: ContextHit[];
	text: string;
}

const DEFAULT_CODEBASE_HITS = 8;
const MAX_FOLDER_FILES = 12;
const MAX_SNIPPET = 1_200;

function clip(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}

	return `${text.slice(0, max)}\n... [обрезано]`;
}

async function readTextUri(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const raw = await vscode.workspace.fs.readFile(uri);
		if (looksBinary(raw) || raw.byteLength > AGENT_LIMITS.maxReadBytes) {
			return undefined;
		}

		return new TextDecoder('utf8', { 
			fatal: false 
		}).decode(raw);
	} catch {
		return undefined;
	}
}

function formatHits(hits: ContextHit[]): string {
	if (hits.length === 0) {
		return '';
	}

	const lines: string[] = ['Контекст из упоминаний:'];
	for (const hit of hits) {
		const range = hit.startLine && hit.endLine ? `:${hit.startLine}-${hit.endLine}` : '';
		lines.push(`### [${hit.source}] ${hit.path}${range} (score ${hit.score})`);
		lines.push(hit.snippet);
		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

export async function searchCodebaseContext(query: string, maxResults = DEFAULT_CODEBASE_HITS): Promise<ContextHit[]> {
	const trimmed = query.trim();
	if (!trimmed) {
		return [];
	}

	const manager = getIndexManager();
	if (!manager) {
		return [];
	}

	const hits: CodebaseSearchHit[] = await manager.search(trimmed, maxResults);
	return hits.map((h) => ({
		source: 'codebase' as const,
		path: h.path,
		startLine: h.startLine,
		endLine: h.endLine,
		score: h.score,
		snippet: clip(h.snippet, MAX_SNIPPET),
	}));
}

export function collectOpenEditorHits(): ContextHit[] {
	const out: ContextHit[] = [];
	const maxChars = Math.min(getSettings().maxInputChars, MAX_SNIPPET);
	for (const editor of vscode.window.visibleTextEditors) {
		const doc = editor.document;
		if (doc.uri.scheme !== 'file') {
			continue;
		}

		const relative = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
		if (!relative || relative.startsWith('.haratsan/')) {
			continue;
		}

		const selected = editor.selection.isEmpty ? '' : doc.getText(editor.selection).trim();
		const body = selected || doc.lineAt(Math.min(editor.selection.active.line, doc.lineCount - 1)).text;
		out.push({
			source: 'editor',
			path: relative,
			startLine: editor.selection.active.line + 1,
			score: selected ? 5 : 2,
			snippet: clip(body || `(открыт: ${doc.languageId})`, maxChars),
		});
	}

	return out;
}

export async function collectFileHit(relativePath: string): Promise<ContextHit | undefined> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}

	const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
	const text = await readTextUri(uri);
	if (text === undefined) {
		return {
			source: 'file',
			path: relativePath,
			score: 0,
			snippet: '(не удалось прочитать файл)',
		};
	}

	return {
		source: 'file',
		path: relativePath,
		score: 10,
		snippet: clip(text, getSettings().maxInputChars),
	};
}

export async function collectFolderHits(relativeFolder: string): Promise<ContextHit[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const pattern = relativeFolder.replace(/\/?$/, '/') + '**/*';
	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, pattern),
		'**/{.haratsan,node_modules,.git}/**',
		MAX_FOLDER_FILES,
	);

	const hits: ContextHit[] = [];
	for (const uri of uris) {
		const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
		const text = await readTextUri(uri);
		hits.push({
			source: 'folder',
			path: relative,
			score: 6,
			snippet: text === undefined
				? '(пропущен: бинарный или слишком большой)'
				: clip(text, Math.floor(getSettings().maxInputChars / 2)),
		});
	}

	return hits;
}

// Ранжирует и склеивает hits в текст для system/user context
export function packContext(hits: ContextHit[], maxChars?: number): ContextPack {
	const cap = maxChars ?? getSettings().maxInputChars * 3;
	const ranked = [...hits].sort((a, b) => b.score - a.score);
	const picked: ContextHit[] = [];
	let used = 0;

	for (const hit of ranked) {
		const cost = hit.path.length + hit.snippet.length + 40;
		if (picked.length > 0 && used + cost > cap) {
			break;
		}

		picked.push(hit);
		used += cost;
	}

	return {
		hits: picked,
		text: formatHits(picked),
	};
}

export async function buildCodebaseContextPack(query: string): Promise<ContextPack> {
	const [codebase, editors] = await Promise.all([
		searchCodebaseContext(query),
		Promise.resolve(collectOpenEditorHits()),
	]);
	return packContext([...codebase, ...editors]);
}
