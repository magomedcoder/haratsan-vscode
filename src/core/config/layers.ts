import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HARATSAN_CONFIG_RELATIVE } from '../../features/project/config';
import { getAdminPolicySnapshot, reloadAdminPolicy, resolveAdminPolicyCandidates } from './adminPolicy';
import { DEFAULT_SETTINGS, type HaratsanSettings } from './types';
import { getHaratsanUserConfigPath } from './userPaths';

/**
 * Слои JSON-конфига (MVP, без remote `.well-known`).
 *
 * Приоритет (низкий * высокий):
 * 1. `DEFAULT_SETTINGS`
 * 2. user: `~/.config/haratsan/config.json`
 * 3. Haratsan Settings UI (`globalState`) - только ключи, отличающиеся от defaults
 * 4. project: `<workspace>/.haratsan/config.json`
 * 5. admin policy (`HARATSAN_ADMIN_POLICY` / `/etc/haratsan/policy.json`) - locked-ключи
 *
 * VSCode `contributes.configuration` сейчас только `haratsan.chatViewLocation` (синхронизируется из effective settings) - не отдельный файл-слой.
 * UI Settings не ломаем: слои аддитивны; project перекрывает user и UI только по ключам, явно заданным в JSON; admin нельзя обойти.
 */

/** Ключи HaratsanSettings, которые можно задать в JSON-слоях */
export const FILE_LAYER_KEYS = [
	'systemPrompt',
	'commentSystemPrompt',
	'primaryTools',
	'modelRoutedPatch',
	'watcherIgnore',
	'webSearchEnabled',
	'webSearchBackend',
	'webSearchHttpUrl',
	'webSearchHttpHeader',
	'webFetchEnabled',
	'skillsPaths',
	'skillsUrls',
	'instructionUrls',
	'personaId',
	'usernameDisplay',
	'deniedPaths',
	'deniedCommands',
	'sensitivePathPatterns',
	'secretPatterns',
	'providerUsePolicy',
	'providerUsePatterns',
	'allowExternalDirectory',
	'enableTerminal',
	'enableFileReading',
	'enableWorkspaceContext',
	'alwaysOnWorkspaceContext',
	'indexingEnabled',
	'indexNewFolders',
	'indexForGrep',
	'formatAfterEdit',
	'agentMaxIterations',
	'autoApprove',
	'persistAlwaysAllow',
	'continueLoopOnDeny',
	'approvalPolicy',
	'baseUrl',
	'smallModel',
	'planModel',
	'actModel',
	'temperature',
	'maxTokens',
	'maxContextTokens',
	'contextOverflowPolicy',
	'requestTimeoutMs',
	'defaultToolTimeoutMs',
	'maxToolTimeoutMs',
	'maxInputChars',
	'planWriteToFile',
	'planShellPolicy',
	'snapshotEnabled',
	'subagentDepth',
	'worktreesEnabled',
	'worktreeStartCommand',
	'toolOutputMaxChars',
	'toolOutputModelMaxChars',
	'gitSyncAutoKeep',
	'embeddingsBaseUrl',
	'embeddingsModel',
	'localEmbeddingsMode',
	'outlineEngine',
	'chunkEngine',
	'compactTailTurns',
	'compactPruneToolResults',
	'compactReservedTokens',
	'midLoopAutoCompact',
	'llmAutoCompact',
	'chatMode',
	'shareMode',
	'revealOnEdit',
	'backgroundEditMode',
	'notifyOnComplete',
	'notifySoundOnComplete',
	'loggingEnabled',
	'otelEnabled',
	'otelEndpoint',
	'visionEnabled',
	'chatTextSize',
	'thinkingDisplay',
	'chatViewLocation',
	'maxTabCount',
	'maxConcurrentRuns',
	'tabEvictionPolicy',
] as const satisfies readonly (keyof HaratsanSettings)[];

export type FileLayerKey = (typeof FILE_LAYER_KEYS)[number];

const FILE_LAYER_KEY_SET = new Set<string>(FILE_LAYER_KEYS);

// Метаданные `.haratsan/config.json` - не маппятся в HaratsanSettings
const META_KEYS = new Set(['version', 'createdAt', '$schema']);

export interface ParsedFileConfig {
	// Overlay для HaratsanSettings (только известные ключи)
	settings: Partial<HaratsanSettings>;
	// Относительный/абсолютный путь к hooks.json
	hooksPath?: string;
	// Inline-хуки из конфига (`hooks: { beforeSubmit: ... }`)
	hooks?: Record<string, unknown>;
}

export interface ConfigLayersSnapshot {
	user: ParsedFileConfig;
	project: ParsedFileConfig;
	userPath: string;
	projectPath: string | undefined;
	// Путь загруженной admin policy (если active)
	adminPolicyPath: string | undefined;
}

const EMPTY_PARSED: ParsedFileConfig = {
	settings: {}
};

let snapshot: ConfigLayersSnapshot = {
	user: EMPTY_PARSED,
	project: EMPTY_PARSED,
	userPath: getHaratsanUserConfigPath(),
	projectPath: undefined,
	adminPolicyPath: undefined,
};

const layerListeners = new Set<() => void>();

/**
 * Deep-merge: объекты рекурсивно, массивы и примитивы - заменой.
 * `undefined` в source пропускаем (не затираем target).
 */
export function deepMerge<T>(target: T, ...sources: unknown[]): T {
	let result: unknown = target;
	for (const source of sources) {
		result = deepMergeOne(result, source);
	}

	return result as T;
}

function deepMergeOne(target: unknown, source: unknown): unknown {
	if (source === undefined) {
		return target;
	}

	if (source === null || typeof source !== 'object' || Array.isArray(source)) {
		return source;
	}

	if (target === null || typeof target !== 'object' || Array.isArray(target)) {
		return deepMergeOne({}, source);
	}

	const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
	for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
		if (value === undefined) {
			continue;
		}
		out[key] = deepMergeOne(out[key], value);
	}

	return out;
}

// Вытащить известные ключи + hooks / hooksPath из сырого JSON
export function parseFileConfig(raw: unknown): ParsedFileConfig {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { settings: {} };
	}

	const obj = raw as Record<string, unknown>;
	const settings: Partial<HaratsanSettings> = {};

	for (const [key, value] of Object.entries(obj)) {
		if (META_KEYS.has(key) || key === 'hooks' || key === 'hooksPath') {
			continue;
		}

		if (!FILE_LAYER_KEY_SET.has(key)) {
			continue;
		}
		
		(settings as Record<string, unknown>)[key] = value;
	}

	const out: ParsedFileConfig = { settings };

	if (typeof obj.hooksPath === 'string' && obj.hooksPath.trim()) {
		out.hooksPath = obj.hooksPath.trim();
	}

	if (obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks)) {
		out.hooks = obj.hooks as Record<string, unknown>;
	}

	return out;
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

function projectConfigPath(): string | undefined {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		return undefined;
	}

	return path.join(root, HARATSAN_CONFIG_RELATIVE);
}

// Текущий снимок слоёв (sync cache)
export function getConfigLayersSnapshot(): ConfigLayersSnapshot {
	return snapshot;
}

// Overlay settings из файлов с приоритетом project > user (без UI - UI мержится в getSettings)
export function getFileSettingsOverlay(): {
	user: Partial<HaratsanSettings>;
	project: Partial<HaratsanSettings>;
} {
	return {
		user: snapshot.user.settings,
		project: snapshot.project.settings,
	};
}

// Эффективный hooksPath (project > user)
export function getEffectiveHooksPath(): string | undefined {
	return snapshot.project.hooksPath ?? snapshot.user.hooksPath;
}

// Inline-хуки: deep-merge user <- project
export function getEffectiveHooksInline(): Record<string, unknown> | undefined {
	const user = snapshot.user.hooks;
	const project = snapshot.project.hooks;
	if (!user && !project) {
		return undefined;
	}

	return deepMerge({}, user ?? {}, project ?? {}) as Record<string, unknown>;
}

export function onConfigLayersChanged(listener: () => void): { dispose(): void } {
	layerListeners.add(listener);
	return {
		dispose: () => {
			layerListeners.delete(listener);
		},
	};
}

function notifyLayerListeners(): void {
	for (const listener of layerListeners) {
		listener();
	}
}

// Перечитать user + project + admin policy в cache
export async function reloadConfigLayers(): Promise<ConfigLayersSnapshot> {
	const userPath = getHaratsanUserConfigPath();
	const projPath = projectConfigPath();

	const [userRaw, projectRaw] = await Promise.all([
		readJsonFile(userPath),
		projPath ? readJsonFile(projPath) : Promise.resolve(undefined),
	]);
	await reloadAdminPolicy();

	const admin = getAdminPolicySnapshot();
	snapshot = {
		user: userRaw !== undefined ? parseFileConfig(userRaw) : { 
			settings: {} 
		},
		project: projectRaw !== undefined ? parseFileConfig(projectRaw) : { 
			settings: {} 
		},
		userPath,
		projectPath: projPath,
		adminPolicyPath: admin.active ? admin.path : undefined,
	};

	notifyLayerListeners();
	return snapshot;
}

/**
 * Ключи UI-хранилища, отличающиеся от DEFAULT_SETTINGS.
 * Так JSON-слои «просвечивают», пока пользователь не менял поле в Settings UI.
 */
export function pickNonDefaultSettings(stored: Partial<HaratsanSettings> | undefined): Partial<HaratsanSettings> {
	if (!stored || typeof stored !== 'object') {
		return {};
	}

	const out: Partial<HaratsanSettings> = {};
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof HaratsanSettings)[]) {
		if (!(key in stored)) {
			continue;
		}

		const value = stored[key];
		if (value === undefined) {
			continue;
		}

		if (stableEqual(value, DEFAULT_SETTINGS[key])) {
			continue;
		}

		(out as Record<string, unknown>)[key] = value;
	}
	return out;
}

function stableEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) {
		return true;
	}

	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

// Подписка на файлы + workspace folders; вызывать из initSettings
export function initConfigLayers(context: vscode.ExtensionContext): void {
	void reloadConfigLayers();

	const projectWatchDisposables: vscode.Disposable[] = [];

	const clearProjectWatchers = (): void => {
		for (const d of projectWatchDisposables) {
			d.dispose();
		}

		projectWatchDisposables.length = 0;
	};

	const startProjectWatcher = (): void => {
		clearProjectWatchers();
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, HARATSAN_CONFIG_RELATIVE));
		const onProject = (): void => {
			void reloadConfigLayers();
		};
		projectWatchDisposables.push(
			watcher,
			watcher.onDidChange(onProject),
			watcher.onDidCreate(onProject),
			watcher.onDidDelete(onProject),
		);
	};

	startProjectWatcher();

	context.subscriptions.push(
		{ 
			dispose: clearProjectWatchers 
		},
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			startProjectWatcher();
			void reloadConfigLayers();
		}),
	);

	// User config вне workspace - AbsolutePattern / путь к файлу
	const userPath = getHaratsanUserConfigPath();
	try {
		const userWatcher = vscode.workspace.createFileSystemWatcher(userPath);
		const onUser = (): void => {
			void reloadConfigLayers();
		};
		context.subscriptions.push(
			userWatcher,
			userWatcher.onDidChange(onUser),
			userWatcher.onDidCreate(onUser),
			userWatcher.onDidDelete(onUser),
		);
	} catch {}

	// Admin policy (системный путь / HARATSAN_ADMIN_POLICY)
	for (const policyPath of resolveAdminPolicyCandidates()) {
		try {
			const policyWatcher = vscode.workspace.createFileSystemWatcher(policyPath);
			const onPolicy = (): void => {
				void reloadConfigLayers();
			};
			context.subscriptions.push(
				policyWatcher,
				policyWatcher.onDidChange(onPolicy),
				policyWatcher.onDidCreate(onPolicy),
				policyWatcher.onDidDelete(onPolicy),
			);
		} catch {}
	}
}
