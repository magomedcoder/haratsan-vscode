import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HaratsanSettings } from './types';
import { DEFAULT_SETTINGS } from './types';

/**
 * Managed / admin policy layer (MDM-паттерн, без полного Enterprise).
 *
 * Путь к policy.json (первый существующий):
 * 1. `HARATSAN_ADMIN_POLICY` - явный путь к файлу
 * 2. Linux/macOS: `/etc/haratsan/policy.json`
 * 3. Windows: `%ProgramData%/haratsan/policy.json`
 *
 * Ключи из файла принудительно перекрывают user / UI / project.
 */

// Ключи HaratsanSettings, которые admin policy может заблокировать / форсировать
export const ADMIN_POLICY_KEYS = [
	'approvalPolicy',
	'autoApprove',
	'continueLoopOnDeny',
	'enableTerminal',
	'enableFileReading',
	'enableWorkspaceContext',
	'webSearchEnabled',
	'webFetchEnabled',
	'allowExternalDirectory',
	'otelEnabled',
	'otelEndpoint',
	'providerUsePolicy',
	'providerUsePatterns',
] as const satisfies readonly (keyof HaratsanSettings)[];

export type AdminPolicyKey = (typeof ADMIN_POLICY_KEYS)[number];

const ADMIN_POLICY_KEY_SET = new Set<string>(ADMIN_POLICY_KEYS);

const META_KEYS = new Set(['$schema', 'version', 'description']);

export interface AdminPolicySnapshot {
	// Файл найден и распарсен (даже если lockedKeys пуст - policy «пустой»)
	active: boolean;
	// Абсолютный путь к загруженному файлу
	path?: string;
	// Overlay HaratsanSettings (только ADMIN_POLICY_KEYS)
	settings: Partial<HaratsanSettings>;
	// Имена заблокированных ключей
	lockedKeys: string[];
}

const EMPTY: AdminPolicySnapshot = {
	active: false,
	settings: {},
	lockedKeys: [],
};

let snapshot: AdminPolicySnapshot = EMPTY;

/**
 * Кандидаты пути к admin policy (порядок приоритета).
 * Если задан `HARATSAN_ADMIN_POLICY` - только он (даже если файла нет * нет политики).
 */
export function resolveAdminPolicyCandidates(): string[] {
	const envPath = process.env.HARATSAN_ADMIN_POLICY?.trim();
	if (envPath) {
		return [path.resolve(envPath)];
	}

	if (process.platform === 'win32') {
		const programData = process.env.PROGRAMDATA?.trim() || 'C:\\ProgramData';
		return [path.join(programData, 'haratsan', 'policy.json')];
	}

	return [path.join('/etc', 'haratsan', 'policy.json')];
}

// Простой glob-like match (`*`, prefix*, *suffix)
export function matchAdminPattern(pattern: string, subject: string): boolean {
	const p = pattern.trim();
	const s = subject.trim();
	if (!p) {
		return false;
	}

	if (p === '*' || p === s) {
		return true;
	}

	if (p.endsWith('*') && p.startsWith('*') && p.length > 1) {
		return s.includes(p.slice(1, -1));
	}

	if (p.endsWith('*')) {
		return s.startsWith(p.slice(0, -1));
	}

	if (p.startsWith('*')) {
		return s.endsWith(p.slice(1));
	}

	return s === p;
}

export function parseAdminPolicy(raw: unknown): {
	settings: Partial<HaratsanSettings>;
	lockedKeys: string[];
} {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {
			settings: {},
			lockedKeys: []
		};
	}

	const obj = raw as Record<string, unknown>;
	const settings: Partial<HaratsanSettings> = {};
	const lockedKeys: string[] = [];

	for (const [key, value] of Object.entries(obj)) {
		if (META_KEYS.has(key) || value === undefined) {
			continue;
		}

		if (!ADMIN_POLICY_KEY_SET.has(key)) {
			continue;
		}
		
		(settings as Record<string, unknown>)[key] = value;
		lockedKeys.push(key);
	}

	lockedKeys.sort();
	return {
		settings,
		lockedKeys
	};
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
	try {
		const text = await fs.readFile(filePath, 'utf8');
		const trimmed = text.trim();
		if (!trimmed) {
			return undefined;
		}

		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

export function getAdminPolicySnapshot(): AdminPolicySnapshot {
	return snapshot;
}

// Есть ли активная admin policy с хотя бы одним locked-ключом
export function isAdminPolicyActive(): boolean {
	return snapshot.active && snapshot.lockedKeys.length > 0;
}

/**
 * Применить admin overlay к уже смерженным settings (после user/UI/project).
 */
export function applyAdminPolicy(merged: Partial<HaratsanSettings>): Partial<HaratsanSettings> {
	if (!snapshot.active || snapshot.lockedKeys.length === 0) {
		return merged;
	}

	return {
		...merged,
		...snapshot.settings
	};
}

// Перед записью в UI globalState: locked-ключи сбрасываем к defaults, чтобы после снятия политики в store не остались «зашитые» значения
export function stripAdminLockedForStorage(settings: HaratsanSettings): HaratsanSettings {
	if (!snapshot.active || snapshot.lockedKeys.length === 0) {
		return settings;
	}

	const out = { ...settings };
	for (const key of ADMIN_POLICY_KEYS) {
		if (!snapshot.lockedKeys.includes(key)) {
			continue;
		}

		const def = DEFAULT_SETTINGS[key];
		(out as Record<string, unknown>)[key] = Array.isArray(def)
			? [...def]
			: typeof def === 'object' && def !== null
				? structuredClone(def)
				: def;
	}

	return out;
}

// Перечитать admin policy с диска
export async function reloadAdminPolicy(): Promise<AdminPolicySnapshot> {
	const candidates = resolveAdminPolicyCandidates();
	const envForced = Boolean(process.env.HARATSAN_ADMIN_POLICY?.trim());

	for (const candidate of candidates) {
		const raw = await readJsonFile(candidate);
		if (raw === undefined) {
			if (envForced) {
				// Явный путь задан, но файла нет - политики нет
				snapshot = EMPTY;
				return snapshot;
			}
			continue;
		}

		const parsed = parseAdminPolicy(raw);
		snapshot = {
			active: true,
			path: candidate,
			settings: parsed.settings,
			lockedKeys: parsed.lockedKeys,
		};
		return snapshot;
	}

	snapshot = EMPTY;
	return snapshot;
}

// Сброс кэша (тесты)
export function resetAdminPolicyForTests(): void {
	snapshot = EMPTY;
}
