import * as path from 'node:path';
import * as vscode from 'vscode';

export const HARATSAN_SHELL_RELATIVE = '.haratsan/shell.json';

export interface ShellProfile {
	description?: string;
	// Переменные окружения (строки)
	env?: Record<string, string>;
	// Префикс к PATH (относительные пути - от корня workspace)
	pathPrepend?: string[];
	// Суффикс к PATH
	pathAppend?: string[];
}

export interface ShellProfilesConfig {
	version: number;
	defaultProfile?: string;
	profiles: Record<string, ShellProfile>;
}

export interface ResolvedShellProfileEnv {
	env: Record<string, string>;
	profileUsed?: string;
	// Нет файла / пустой config - не ошибка
	error?: string;
}

const EMPTY_ENV: ResolvedShellProfileEnv = {
	env: {}
};

function folderFsPath(explicit?: string): string | undefined {
	return explicit ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function asStringRecord(raw: unknown): Record<string, string> | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}

	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const k = key.trim();
		if (!k) {
			continue;
		}

		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			out[k] = String(value);
		}
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

function asStringList(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}

	const out = raw.filter((item): item is string => typeof item === 'string').map((s) => s.trim()).filter(Boolean);
	return out.length > 0 ? out : undefined;
}

function parseProfile(raw: unknown): ShellProfile | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	const env = asStringRecord(obj.env);
	const pathPrepend = asStringList(obj.pathPrepend);
	const pathAppend = asStringList(obj.pathAppend);
	const description = typeof obj.description === 'string' ? obj.description.trim() : undefined;
	if (!env && !pathPrepend && !pathAppend && !description) {
		return undefined;
	}

	return {
		...(description ? { description } : {}),
		...(env ? { env } : {}),
		...(pathPrepend ? { pathPrepend } : {}),
		...(pathAppend ? { pathAppend } : {}),
	};
}

/**
 * Разобрать JSON `.haratsan/shell.json`
 * Поддержка:
 * - именованные `profiles` + `defaultProfile`
 * - shorthand top-level `env` / `pathPrepend` / `pathAppend` -> профиль `default`
 */
export function parseShellProfilesJson(raw: unknown): ShellProfilesConfig | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	const profiles: Record<string, ShellProfile> = {};

	if (obj.profiles && typeof obj.profiles === 'object' && !Array.isArray(obj.profiles)) {
		for (const [name, value] of Object.entries(obj.profiles as Record<string, unknown>)) {
			const key = name.trim();
			if (!key) {
				continue;
			}

			const profile = parseProfile(value);
			if (profile) {
				profiles[key] = profile;
			}
		}
	}

	// Shorthand без profiles -> default
	const shorthand = parseProfile({
		env: obj.env,
		pathPrepend: obj.pathPrepend,
		pathAppend: obj.pathAppend,
		description: obj.description,
	});
	if (shorthand && Object.keys(profiles).length === 0) {
		profiles.default = shorthand;
	} else if (shorthand && !profiles.default) {
		// Top-level env мержится в default, если его ещё нет
		profiles.default = shorthand;
	}

	if (Object.keys(profiles).length === 0) {
		return undefined;
	}

	const version = typeof obj.version === 'number' && Number.isFinite(obj.version)
		? Math.floor(obj.version)
		: 1;
	const defaultProfile = typeof obj.defaultProfile === 'string' && obj.defaultProfile.trim()
		? obj.defaultProfile.trim()
		: undefined;

	return {
		version,
		...(defaultProfile ? { defaultProfile } : {}),
		profiles,
	};
}

// Собрать PATH: prepend + base + append (dedupe, пустые отбросить)
export function buildPathEnv(opts: {
	basePath?: string;
	prepend?: string[];
	append?: string[];
	workspaceRoot?: string;
}): string | undefined {
	const sep = path.delimiter;
	const resolveEntry = (entry: string): string => {
		if (path.isAbsolute(entry)) {
			return entry;
		}

		if (opts.workspaceRoot) {
			return path.resolve(opts.workspaceRoot, entry);
		}

		return entry;
	};

	const parts: string[] = [];
	const seen = new Set<string>();
	const push = (raw: string) => {
		const p = raw.trim();
		if (!p || seen.has(p)) {
			return;
		}

		seen.add(p);
		parts.push(p);
	};

	for (const p of opts.prepend ?? []) {
		push(resolveEntry(p));
	}

	for (const p of (opts.basePath ?? '').split(sep)) {
		push(p);
	}

	for (const p of opts.append ?? []) {
		push(resolveEntry(p));
	}

	return parts.length > 0 ? parts.join(sep) : undefined;
}

/**
 * Выбрать профиль и собрать env (без process.env - только overlay для spawn).
 * Приоритет имени: explicit -> HARATSAN_SHELL_PROFILE -> defaultProfile -> "default" -> первый ключ.
 */
export function resolveShellProfileEnv(opts: {
	config: ShellProfilesConfig | undefined;
	profileName?: string;
	// process.env.PATH (или аналог) для pathPrepend/Append
	basePath?: string;
	workspaceRoot?: string;
	// process.env.HARATSAN_SHELL_PROFILE
	envProfileOverride?: string;
}): ResolvedShellProfileEnv {
	const config = opts.config;
	if (!config || Object.keys(config.profiles).length === 0) {
		return EMPTY_ENV;
	}

	const requested = (opts.profileName ?? '').trim() || (opts.envProfileOverride ?? '').trim()
		|| (config.defaultProfile ?? '').trim()
		|| (config.profiles.default ? 'default' : '')
		|| Object.keys(config.profiles)[0]!;

	const profile = config.profiles[requested];
	if (!profile) {
		return {
			env: {},
			error: `неизвестный shell profile «${requested}» (есть: ${Object.keys(config.profiles).join(', ')})`,
		};
	}

	const env: Record<string, string> = { ...(profile.env ?? {}) };
	const pathValue = buildPathEnv({
		basePath: opts.basePath ?? process.env.PATH ?? '',
		prepend: profile.pathPrepend,
		append: profile.pathAppend,
		workspaceRoot: opts.workspaceRoot,
	});
	if (pathValue && (profile.pathPrepend?.length || profile.pathAppend?.length)) {
		env.PATH = pathValue;
	}

	return {
		env,
		profileUsed: requested,
	};
}

// Загрузить `.haratsan/shell.json` из workspace (нет файла -> undefined)
export async function loadShellProfiles(folderPath?: string): Promise<ShellProfilesConfig | undefined> {
	const root = folderFsPath(folderPath);
	if (!root) {
		return undefined;
	}

	const uri = vscode.Uri.file(path.join(root, HARATSAN_SHELL_RELATIVE));
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		return parseShellProfilesJson(raw);
	} catch {
		return undefined;
	}
}

// Env overlay для spawn: profile (+ опц. имя) из `.haratsan/shell.json`
export async function getShellProfileEnv(opts?: {
	profileName?: string;
	folderPath?: string;
}): Promise<ResolvedShellProfileEnv> {
	const root = folderFsPath(opts?.folderPath);
	const config = await loadShellProfiles(opts?.folderPath);
	return resolveShellProfileEnv({
		config,
		profileName: opts?.profileName,
		basePath: process.env.PATH,
		workspaceRoot: root,
		envProfileOverride: process.env.HARATSAN_SHELL_PROFILE,
	});
}

// Смержить слои env (поздний перекрывает ранний)
export function mergeEnvLayers(...layers: Array<Record<string, string> | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const layer of layers) {
		if (!layer) {
			continue;
		}

		Object.assign(out, layer);
	}

	return out;
}
