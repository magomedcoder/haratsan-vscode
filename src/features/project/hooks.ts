import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { AGENT_LIMITS, previewText } from '../agent/policy';
import { getEffectiveHooksInline, getEffectiveHooksPath } from '../../core/config/layers';
import { writeLog } from '../../core/log/logger';

const execFileAsync = promisify(execFile);

export type HookEvent = | 'beforeSubmit' | 'beforeShell' | 'session.diff' | 'session.compacting' | 'shell.env' | 'file.watcher';

export interface HookCommand {
	command: string;
}

export interface ProjectHooks {
	beforeSubmit: HookCommand[];
	beforeShell: HookCommand[];
	sessionDiff: HookCommand[];
	sessionCompacting: HookCommand[];
	shellEnv: HookCommand[];
	fileWatcher: HookCommand[];
}

export interface HookRunResult {
	ok: boolean;
	vetoed: boolean;
	stderr?: string;
	stdout?: string;
	command?: string;
	// Смерженные env из stdout хуков shell.env
	env?: Record<string, string>;
}

const MAX_HOOK_OUTPUT = 4_000;
const HOOK_TIMEOUT_MS = 15_000;

const EMPTY_HOOKS: ProjectHooks = {
	beforeSubmit: [],
	beforeShell: [],
	sessionDiff: [],
	sessionCompacting: [],
	shellEnv: [],
	fileWatcher: [],
};

function asHookList(raw: unknown): HookCommand[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const out: HookCommand[] = [];
	for (const item of raw) {
		if (typeof item === 'string' && item.trim()) {
			out.push({ command: item.trim() });
			continue;
		}

		if (item && typeof item === 'object' && typeof (item as { command?: unknown }).command === 'string') {
			const command = String((item as { command: string }).command).trim();
			if (command) {
				out.push({ command });
			}
		}
	}
	return out;
}

// Первый непустой список из альтернативных ключей JSON
function pickHookList(hooks: Record<string, unknown>, ...keys: string[]): HookCommand[] {
	for (const key of keys) {
		if (key in hooks) {
			return asHookList(hooks[key]);
		}
	}
	return [];
}

function hooksForEvent(hooks: ProjectHooks, event: HookEvent): HookCommand[] {
	switch (event) {
		case 'beforeSubmit':
			return hooks.beforeSubmit;
		case 'beforeShell':
			return hooks.beforeShell;
		case 'session.diff':
			return hooks.sessionDiff;
		case 'session.compacting':
			return hooks.sessionCompacting;
		case 'shell.env':
			return hooks.shellEnv;
		case 'file.watcher':
			return hooks.fileWatcher;
	}
}

// Notify-события: ненулевой exit не блокирует действие
function isNotifyOnly(event: HookEvent): boolean {
	return event === 'session.diff' || event === 'file.watcher';
}

// Загрузить hooks: hooksPath из слоёв конфига * иначе `.haratsan/hooks.json`, плюс inline `hooks` из JSON
export async function loadProjectHooks(): Promise<ProjectHooks> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const fromFile = folder
		? await readHooksFile(resolveHooksUri(folder))
		: { ...EMPTY_HOOKS };
	const inline = parseHooksRecord(getEffectiveHooksInline());
	// Inline из config layers поверх файла (project/user уже смержены в getEffectiveHooksInline)
	return mergeHooks(fromFile, inline);
}

function resolveHooksUri(folder: vscode.WorkspaceFolder): vscode.Uri {
	const configured = getEffectiveHooksPath();
	if (configured) {
		if (path.isAbsolute(configured)) {
			return vscode.Uri.file(configured);
		}

		return vscode.Uri.joinPath(folder.uri, configured);
	}

	return vscode.Uri.joinPath(folder.uri, '.haratsan', 'hooks.json');
}

async function readHooksFile(uri: vscode.Uri): Promise<ProjectHooks> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const raw = JSON.parse(new TextDecoder().decode(bytes)) as {
			hooks?: Record<string, unknown>;
			beforeSubmit?: unknown;
			beforeShell?: unknown;
			sessionDiff?: unknown;
			sessionCompacting?: unknown;
		};
		const hooks = (raw.hooks ?? raw) as Record<string, unknown>;
		return parseHooksRecord(hooks);
	} catch {
		return { ...EMPTY_HOOKS };
	}
}

function parseHooksRecord(hooks: Record<string, unknown> | undefined): ProjectHooks {
	if (!hooks) {
		return { ...EMPTY_HOOKS };
	}
	return {
		beforeSubmit: asHookList(hooks.beforeSubmit),
		beforeShell: asHookList(hooks.beforeShell),
		sessionDiff: pickHookList(hooks, 'sessionDiff', 'session.diff'),
		sessionCompacting: pickHookList(
			hooks,
			'sessionCompacting',
			'session.compacting',
		),
		shellEnv: pickHookList(hooks, 'shellEnv', 'shell.env'),
		fileWatcher: pickHookList(hooks, 'fileWatcher', 'file.watcher'),
	};
}

// Списки из overlay заменяют непустые; пустой overlay не затирает файл
function mergeHooks(base: ProjectHooks, overlay: ProjectHooks): ProjectHooks {
	return {
		beforeSubmit: overlay.beforeSubmit.length > 0 ? overlay.beforeSubmit : base.beforeSubmit,
		beforeShell: overlay.beforeShell.length > 0 ? overlay.beforeShell : base.beforeShell,
		sessionDiff: overlay.sessionDiff.length > 0 ? overlay.sessionDiff : base.sessionDiff,
		sessionCompacting: overlay.sessionCompacting.length > 0
			? overlay.sessionCompacting
			: base.sessionCompacting,
		shellEnv: overlay.shellEnv.length > 0 ? overlay.shellEnv : base.shellEnv,
		fileWatcher: overlay.fileWatcher.length > 0 ? overlay.fileWatcher : base.fileWatcher,
	};
}

async function runShellHook(
	command: string,
	cwd: string,
	envExtra: Record<string, string>,
	signal?: AbortSignal,
): Promise<HookRunResult> {
	const isWin = process.platform === 'win32';
	const shell = isWin ? 'cmd.exe' : '/bin/sh';
	const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
	try {
		const { stdout, stderr } = await execFileAsync(shell, args, {
			cwd,
			timeout: HOOK_TIMEOUT_MS,
			maxBuffer: AGENT_LIMITS.maxCommandOutput,
			signal,
			env: {
				...process.env,
				FORCE_COLOR: '0',
				NO_COLOR: '1',
				...envExtra,
			},
		});
		return {
			ok: true,
			vetoed: false,
			stdout: previewText(String(stdout ?? ''), MAX_HOOK_OUTPUT),
			stderr: previewText(String(stderr ?? ''), MAX_HOOK_OUTPUT),
			command,
		};
	} catch (err) {
		const execErr = err as NodeJS.ErrnoException & {
			code?: number | string;
			stdout?: string;
			stderr?: string;
			killed?: boolean;
		};
		if (execErr.name === 'AbortError' || signal?.aborted) {
			const abortErr = new Error(vscode.l10n.t('agent.operationCancelled'));
			abortErr.name = 'AbortError';
			throw abortErr;
		}

		const stderr = previewText(String(execErr.stderr ?? execErr.message ?? err), MAX_HOOK_OUTPUT);
		return {
			ok: false,
			vetoed: true,
			stdout: previewText(String(execErr.stdout ?? ''), MAX_HOOK_OUTPUT),
			stderr,
			command,
		};
	}
}

export async function runHookEvent(
	event: HookEvent,
	envExtra: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<HookRunResult> {
	const hooks = await loadProjectHooks();
	const list = hooksForEvent(hooks, event);
	if (list.length === 0) {
		return { ok: true, vetoed: false };
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	const cwd = folder?.uri.fsPath ?? process.cwd();
	const notifyOnly = isNotifyOnly(event);

	for (const item of list) {
		const result = await runShellHook(item.command, cwd, {
			HARATSAN_HOOK_EVENT: event,
			...envExtra,
		}, signal);
		if (result.vetoed || !result.ok) {
			if (notifyOnly) {
				// soft failure - логируем, не блокируем
				writeLog(
					'agent',
					`[hooks] ${event} soft failure: ${item.command}${result.stderr ? ` - ${result.stderr}` : ''}`,
				);
				continue;
			}
			return {
				...result,
				vetoed: true,
				stderr: result.stderr?.trim()
					|| vscode.l10n.t('chat.hooks.veto', event, item.command),
			};
		}
	}

	return { 
		ok: true, 
		vetoed: false 
	};
}

export async function runBeforeSubmitHook(text: string, signal?: AbortSignal): Promise<HookRunResult> {
	return runHookEvent('beforeSubmit', {
		HARATSAN_HOOK_TEXT: text.slice(0, 4_000),
	}, signal);
}

export async function runBeforeShellHook(commandLine: string, signal?: AbortSignal): Promise<HookRunResult> {
	return runHookEvent('beforeShell', {
		HARATSAN_HOOK_COMMAND: commandLine.slice(0, 2_000),
	}, signal);
}

// Notify после turn-diff: пути через HARATSAN_HOOK_PATHS
export async function runSessionDiffHook(paths: string[], turnId: string): Promise<HookRunResult> {
	return runHookEvent('session.diff', {
		HARATSAN_HOOK_PATHS: paths.join('\n').slice(0, 8_000),
		HARATSAN_HOOK_TURN_ID: turnId.slice(0, 200),
	});
}

// Перед compact: ненулевой exit блокирует уплотнение
export async function runSessionCompactingHook(signal?: AbortSignal): Promise<HookRunResult> {
	return runHookEvent('session.compacting', {}, signal);
}

/**
 * Разобрать env из stdout хука shell.env.
 * Форматы: JSON `{"env":{"K":"V"}}` / `{"K":"V"}`, либо строки `KEY=value`.
 */
export function parseEnvFromHookStdout(stdout: string): Record<string, string> {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return {};
	}

	// Чистый JSON (весь stdout)
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const fromJson = envMapFromJson(parsed);
		if (fromJson) {
			return fromJson;
		}
	} catch {}

	// Последний JSON-объект в выводе (если был echo + JSON)
	const lastBrace = trimmed.lastIndexOf('{');
	if (lastBrace >= 0) {
		try {
			const parsed = JSON.parse(trimmed.slice(lastBrace)) as unknown;
			const fromJson = envMapFromJson(parsed);
			if (fromJson) {
				return fromJson;
			}
		} catch {}
	}

	const out: Record<string, string> = {};
	for (const line of trimmed.split(/\r?\n/)) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
		if (m) {
			out[m[1]!] = m[2]!;
		}
	}

	return out;
}

function envMapFromJson(parsed: unknown): Record<string, string> | undefined {
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}

	const obj = parsed as Record<string, unknown>;
	const source = (obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env))
		? obj.env as Record<string, unknown>
		: obj;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (key === 'env' && obj.env && typeof obj.env === 'object') {
			continue;
		}

		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			out[key] = String(value);
		}
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Перед spawn run_command: inject/modify env (или veto).
 * Env: HARATSAN_HOOK_EVENT=shell.env, HARATSAN_HOOK_COMMAND, HARATSAN_HOOK_CWD.
 * stdout * merge env map (JSON или KEY=value).
 */
export async function runShellEnvHook(
	commandLine: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<HookRunResult> {
	const hooks = await loadProjectHooks();
	const list = hooks.shellEnv;
	if (list.length === 0) {
		return { 
			ok: true, 
			vetoed: false, 
			env: {} 
		};
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	const hookCwd = folder?.uri.fsPath ?? process.cwd();
	const merged: Record<string, string> = {};

	for (const item of list) {
		const result = await runShellHook(item.command, hookCwd, {
			HARATSAN_HOOK_EVENT: 'shell.env',
			HARATSAN_HOOK_COMMAND: commandLine.slice(0, 2_000),
			HARATSAN_HOOK_CWD: cwd.slice(0, 2_000),
		}, signal);

		if (result.vetoed || !result.ok) {
			return {
				...result,
				vetoed: true,
				env: {},
				stderr: result.stderr?.trim() || vscode.l10n.t('chat.hooks.veto', 'shell.env', item.command),
			};
		}

		Object.assign(merged, parseEnvFromHookStdout(result.stdout ?? ''));
	}

	return { 
		ok: true, 
		vetoed: false, 
		env: merged 
	};
}

export type FileWatcherEventKind = 'create' | 'change' | 'delete';

/**
 * Notify (soft failure): изменения под `.haratsan/**`.
 * Env: HARATSAN_HOOK_PATH, HARATSAN_HOOK_FILE_EVENT, HARATSAN_HOOK_PATHS, HARATSAN_HOOK_FILE_EVENTS.
 */
export async function runFileWatcherHook(
	entries: Array<{ path: string; event: FileWatcherEventKind }>,
): Promise<HookRunResult> {
	if (entries.length === 0) {
		return { ok: true, vetoed: false };
	}

	const paths = entries.map((e) => e.path);
	const events = entries.map((e) => e.event);
	return runHookEvent('file.watcher', {
		HARATSAN_HOOK_PATH: paths[0]!.slice(0, 2_000),
		HARATSAN_HOOK_FILE_EVENT: events[0]!,
		HARATSAN_HOOK_PATHS: paths.join('\n').slice(0, 8_000),
		HARATSAN_HOOK_FILE_EVENTS: events.join('\n').slice(0, 4_000),
	});
}
