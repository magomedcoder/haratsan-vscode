import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AGENT_LIMITS, looksBinary } from '../agent/policy';
import { getSettings } from '../../core/config/settings';
import type { ContextHit } from '../index/contextEngine';
import { HARATSAN_DIR_RELATIVE } from './config';

// Манифест именованных ссылок (alias * path | git)
export const REFERENCES_JSON_RELATIVE = `${HARATSAN_DIR_RELATIVE}/references.json`;
// Папка с отдельными JSON на alias (опционально)
export const REFERENCES_DIR_RELATIVE = `${HARATSAN_DIR_RELATIVE}/references`;
// Managed-кэш после copy / shallow-clone
export const REFERENCES_CACHE_RELATIVE = `${HARATSAN_DIR_RELATIVE}/cache/references`;

const META_FILE = '.haratsan-ref.json';
const MAX_REF_FILES = 12;

export interface ReferenceDef {
	alias: string;
	// Локальный путь (относительно workspace или абсолютный)
	path?: string;
	// URL git-репозитория
	git?: string;
	// Ветка для shallow-clone
	branch?: string;
	description?: string;
}

interface ReferencesFile {
	version?: number;
	references?: Record<string, Omit<ReferenceDef, 'alias'>> | ReferenceDef[];
}

interface CacheMeta {
	alias: string;
	source: 'path' | 'git';
	path?: string;
	git?: string;
	branch?: string;
	syncedAt: string;
}

export interface ResolvedReferenceCache {
	alias: string;
	cacheRel: string;
	cacheAbs: string;
	isFile: boolean;
	def: ReferenceDef;
}

function folderRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isSafeAlias(name: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
}

function clip(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}

	return `${text.slice(0, max)}\n... [обрезано]`;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(dir);
		return entries.some((e) => e !== META_FILE);
	} catch {
		return false;
	}
}

function normalizeEntry(alias: string, raw: Omit<ReferenceDef, 'alias'> | ReferenceDef): ReferenceDef | undefined {
	const name = alias.trim();
	if (!name || !isSafeAlias(name)) {
		return undefined;
	}

	const pathVal = typeof raw.path === 'string' ? raw.path.trim() : undefined;
	const gitVal = typeof raw.git === 'string' ? raw.git.trim() : undefined;
	if (!pathVal && !gitVal) {
		return undefined;
	}

	return {
		alias: name,
		path: pathVal || undefined,
		git: gitVal || undefined,
		branch: typeof raw.branch === 'string' ? raw.branch.trim() || undefined : undefined,
		description: typeof raw.description === 'string' ? raw.description.trim() || undefined : undefined,
	};
}

async function readJsonFile(abs: string): Promise<unknown | undefined> {
	try {
		const text = await fs.readFile(abs, 'utf8');
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

// Загрузить все reference-определения из `.haratsan/references.json` и `.haratsan/references/*.json`
export async function loadReferenceDefs(): Promise<ReferenceDef[]> {
	const root = folderRoot();
	if (!root) {
		return [];
	}

	const byAlias = new Map<string, ReferenceDef>();

	const manifest = await readJsonFile(path.join(root, REFERENCES_JSON_RELATIVE));
	if (manifest && typeof manifest === 'object') {
		const file = manifest as ReferencesFile;
		const refs = file.references;
		if (Array.isArray(refs)) {
			for (const item of refs) {
				if (!item || typeof item !== 'object') {
					continue;
				}

				const alias = typeof (item as ReferenceDef).alias === 'string'
					? (item as ReferenceDef).alias
					: '';
				const def = normalizeEntry(alias, item);
				if (def) {
					byAlias.set(def.alias.toLowerCase(), def);
				}
			}
		} else if (refs && typeof refs === 'object') {
			for (const [alias, raw] of Object.entries(refs)) {
				if (!raw || typeof raw !== 'object') {
					continue;
				}

				const def = normalizeEntry(alias, raw);
				if (def) {
					byAlias.set(def.alias.toLowerCase(), def);
				}
			}
		}
	}

	const dir = path.join(root, REFERENCES_DIR_RELATIVE);
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const ent of entries) {
			if (!ent.isFile() || !ent.name.endsWith('.json')) {
				continue;
			}

			const aliasFromName = ent.name.replace(/\.json$/i, '');
			const raw = await readJsonFile(path.join(dir, ent.name));
			if (!raw || typeof raw !== 'object') {
				continue;
			}

			const obj = raw as Record<string, unknown>;
			const alias = typeof obj.alias === 'string' ? obj.alias : aliasFromName;
			const def = normalizeEntry(alias, obj as Omit<ReferenceDef, 'alias'>);
			if (def) {
				byAlias.set(def.alias.toLowerCase(), def);
			}
		}
	} catch {}

	return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function findReferenceDef(name: string): Promise<ReferenceDef | undefined> {
	const needle = name.trim().toLowerCase();
	if (!needle) {
		return undefined;
	}

	const all = await loadReferenceDefs();
	return all.find((d) => d.alias.toLowerCase() === needle);
}

function resolveLocalSourceAbs(root: string, localPath: string): string {
	return path.isAbsolute(localPath) ? path.resolve(localPath) : path.resolve(root, localPath);
}

function runGit(args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve) => {
		const c = spawn('git', args, { cwd });
		let stderr = '';
		c.stderr.on('data', (d) => {
			stderr += String(d);
		});
		c.on('error', (err) => resolve({ 
			code: 1, 
			stderr: err.message 
		}));
		c.on('close', (code) => resolve({ 
			code: code ?? 1, 
			stderr 
		}));
	});
}

async function writeMeta(cacheAbs: string, meta: CacheMeta): Promise<void> {
	await fs.writeFile(path.join(cacheAbs, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

async function syncPathReference(root: string, def: ReferenceDef, cacheAbs: string): Promise<string | undefined> {
	if (!def.path) {
		return 'не указан path';
	}

	const srcAbs = resolveLocalSourceAbs(root, def.path);
	try {
		const st = await fs.stat(srcAbs);
		try {
			await fs.rm(cacheAbs, { 
				recursive: true, 
				force: true 
			});
		} catch {}
		await fs.mkdir(path.dirname(cacheAbs), { recursive: true });
		if (st.isFile()) {
			await fs.mkdir(cacheAbs, { recursive: true });
			const dest = path.join(cacheAbs, path.basename(srcAbs));
			await fs.copyFile(srcAbs, dest);
		} else if (st.isDirectory()) {
			await fs.cp(srcAbs, cacheAbs, { 
				recursive: true, 
				force: true 
			});
		} else {
			return `путь не файл и не папка: ${def.path}`;
		}

		await writeMeta(cacheAbs, {
			alias: def.alias,
			source: 'path',
			path: def.path,
			syncedAt: new Date().toISOString(),
		});
		return undefined;
	} catch (err) {
		return `не удалось скопировать «${def.path}»: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function syncGitReference(root: string, def: ReferenceDef, cacheAbs: string): Promise<string | undefined> {
	if (!def.git) {
		return 'не указан git';
	}

	const parent = path.dirname(cacheAbs);
	await fs.mkdir(parent, { recursive: true });
	try {
		await fs.rm(cacheAbs, { recursive: true, force: true });
	} catch {}

	const args = ['clone', '--depth', '1'];
	if (def.branch) {
		args.push('--branch', def.branch);
	}
	args.push('--', def.git, cacheAbs);

	const result = await runGit(args, root);
	if (result.code !== 0) {
		return `git clone не удался: ${(result.stderr || 'unknown').slice(0, 500)}`;
	}

	await writeMeta(cacheAbs, {
		alias: def.alias,
		source: 'git',
		git: def.git,
		branch: def.branch,
		syncedAt: new Date().toISOString(),
	});
	return undefined;
}

/**
 * Убедиться, что alias лежит в `.haratsan/cache/references/<alias>/`.
 * При отсутствии кэша - copy (path) или shallow-clone (git).
 */
export async function ensureReferenceCached(alias: string): Promise<ResolvedReferenceCache | { error: string }> {
	const root = folderRoot();
	if (!root) {
		return { 
			error: 'нет workspace' 
		};
	}

	const name = alias.trim();
	if (!name) {
		return { 
			error: 'укажи имя: @alias name или @ref:name' 
		};
	}

	if (!isSafeAlias(name)) {
		return { 
			error: `недопустимый alias «${name}» (только латиница, цифры, _ и -)` 
	};
	}

	const def = await findReferenceDef(name);
	if (!def) {
		return { 
			error: `reference «${name}» не найден в .haratsan/references.json` 
		};
	}

	const cacheRel = `${REFERENCES_CACHE_RELATIVE}/${def.alias}`.replace(/\\/g, '/');
	const cacheAbs = path.join(root, ...cacheRel.split('/'));

	if (!(await isNonEmptyDir(cacheAbs))) {
		const err = def.git
			? await syncGitReference(root, def, cacheAbs)
			: await syncPathReference(root, def, cacheAbs);
		if (err) {
			return { error: err };
		}
	}

	// Один файл в кэше (кроме meta) * режим @file
	let isFile = false;
	try {
		const entries = (await fs.readdir(cacheAbs)).filter((e) => e !== META_FILE);
		if (entries.length === 1) {
			const only = path.join(cacheAbs, entries[0]!);
			const st = await fs.stat(only);
			isFile = st.isFile();
		}
	} catch {
		return { 
			error: `кэш reference «${def.alias}» недоступен` 
		};
	}

	return {
		alias: def.alias,
		cacheRel,
		cacheAbs,
		isFile,
		def,
	};
}

async function readTextFile(abs: string): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(abs);
		if (looksBinary(raw) || raw.byteLength > AGENT_LIMITS.maxReadBytes) {
			return undefined;
		}

		return new TextDecoder('utf8', { fatal: false }).decode(raw);
	} catch {
		return undefined;
	}
}

async function walkFiles(absDir: string, relBase: string, out: string[], budget: number): Promise<void> {
	if (out.length >= budget) {
		return;
	}

	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(absDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const ent of entries) {
		if (out.length >= budget) {
			return;
		}

		if (ent.name === META_FILE || ent.name === '.git' || ent.name === 'node_modules') {
			continue;
		}

		const abs = path.join(absDir, ent.name);
		const rel = `${relBase}/${ent.name}`.replace(/\\/g, '/');
		if (ent.isDirectory()) {
			await walkFiles(abs, rel, out, budget);
		} else if (ent.isFile()) {
			out.push(rel);
		}
	}
}

// Собрать ContextHit из кэша reference (обход fs - findFiles исключает `.haratsan`)
export async function collectReferenceHits(resolved: ResolvedReferenceCache): Promise<ContextHit[]> {
	const root = folderRoot();
	if (!root) {
		return [];
	}

	const maxChars = getSettings().maxInputChars;

	if (resolved.isFile) {
		const entries = (await fs.readdir(resolved.cacheAbs)).filter((e) => e !== META_FILE);
		const fileName = entries[0];
		if (!fileName) {
			return [];
		}

		const rel = `${resolved.cacheRel}/${fileName}`.replace(/\\/g, '/');
		const text = await readTextFile(path.join(resolved.cacheAbs, fileName));
		return [{
			source: 'file',
			path: rel,
			score: 10,
			snippet: text === undefined ? '(не удалось прочитать файл)' : clip(text, maxChars),
		}];
	}

	const relPaths: string[] = [];
	await walkFiles(resolved.cacheAbs, resolved.cacheRel, relPaths, MAX_REF_FILES);
	const hits: ContextHit[] = [];
	for (const rel of relPaths) {
		const abs = path.join(root, ...rel.split('/'));
		const text = await readTextFile(abs);
		hits.push({
			source: 'folder',
			path: rel,
			score: 6,
			snippet: text === undefined
				? '(пропущен: бинарный или слишком большой)'
				: clip(text, Math.floor(maxChars / 2)),
		});
	}
	return hits;
}

// Описание источника для блока контекста (RU)
export function formatReferenceSourceBlock(resolved: ResolvedReferenceCache): string {
	const src = resolved.def.git
		? `git ${resolved.def.git}${resolved.def.branch ? ` (branch ${resolved.def.branch})` : ''}`
		: `path ${resolved.def.path ?? '?'}`;
	return `[alias ${resolved.alias}] ${src} * ${resolved.cacheRel}`;
}
