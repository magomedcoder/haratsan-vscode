import ignore, { type Ignore } from 'ignore';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type IgnoreMatcher = Ignore;

// Кэш матчера на корень workspace за turn агента.
const cache = new Map<string, IgnoreMatcher>();

export function clearIgnoreCache(): void {
	cache.clear();
}

export function createIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
	const ig = ignore();
	// Каталог .git никогда не часть рабочего дерева для агента
	ig.add('.git');
	for (const line of patterns) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		ig.add(trimmed);
	}

	return ig;
}

export function ignoresRelative(matcher: IgnoreMatcher, relativePosix: string): boolean {
	const normalized = relativePosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
	if (!normalized || normalized === '.') {
		return false;
	}

	if (matcher.ignores(normalized)) {
		return true;
	}

	// Шаблоны вида dist/ требуют завершающий слэш для каталога
	return matcher.ignores(`${normalized}/`);
}

// Совпадает ли относительный путь с glob/gitignore-паттернами watcherIgnore
export function matchesWatcherIgnore(relPath: string, patterns: readonly string[]): boolean {
	const active = patterns.map((p) => p.trim()).filter((p) => p && !p.startsWith('#'));
	if (active.length === 0) {
		return false;
	}

	return ignoresRelative(createIgnoreMatcher(active), relPath);
}

async function readIgnoreLines(folderFsPath: string, fileName: string): Promise<string[]> {
	try {
		const text = await fs.readFile(path.join(folderFsPath, fileName), 'utf8');
		return text.split(/\r?\n/);
	} catch {
		return [];
	}
}

/**
 * Матчер корня workspace: `.gitignore` + `.haratsanignore` + `.ignore` + `.rgignore` (если есть)
 * (+ встроенный `.git`). Строки `!` (re-include) передаются в `ignore` как есть.
 * Не spawn'ит `git check-ignore`.
 */
export async function getFolderIgnoreMatcher(folderFsPath: string): Promise<IgnoreMatcher> {
	const key = path.resolve(folderFsPath);
	const cached = cache.get(key);
	if (cached) {
		return cached;
	}

	const [gitignore, haratsanIgnore, dotIgnore, rgignore] = await Promise.all([
		readIgnoreLines(key, '.gitignore'),
		readIgnoreLines(key, '.haratsanignore'),
		readIgnoreLines(key, '.ignore'),
		readIgnoreLines(key, '.rgignore'),
	]);

	const matcher = createIgnoreMatcher([...gitignore, ...haratsanIgnore, ...dotIgnore, ...rgignore]);
	cache.set(key, matcher);
	return matcher;
}

export async function isIgnoredByGitIgnore(folderFsPath: string, relativePosix: string): Promise<boolean> {
	const matcher = await getFolderIgnoreMatcher(folderFsPath);
	return ignoresRelative(matcher, relativePosix);
}
