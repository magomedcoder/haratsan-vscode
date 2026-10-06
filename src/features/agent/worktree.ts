import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import { HARATSAN_DIR_RELATIVE } from '../project/config';
import { AGENT_LIMITS, previewText } from './policy';
import { resolveHostShellInvoker } from './scriptRunner';
import { defaultWorkspaceCwd } from './shellSession';

const execFileAsync = promisify(execFile);

// Относительный каталог worktrees внутри workspace
export const WORKTREES_DIR_RELATIVE = path.join(HARATSAN_DIR_RELATIVE, 'worktrees');

export interface WorktreeCreateResult {
	ok: boolean;
	// Абсолютный путь worktree (cwd субагента)
	cwd?: string;
	// Имя созданной ветки
	branch?: string;
	// Короткий slug каталога
	slug?: string;
	// Вывод git / startCommand (для отчёта)
	detail: string;
	// Не git-репозиторий - вызывающий должен продолжить без worktree
	notGitRepo?: boolean;
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const { stdout, stderr } = await execFileAsync('git', args, {
		cwd,
		timeout: 60_000,
		maxBuffer: AGENT_LIMITS.maxGitOutput,
		signal,
	});
	return `${stdout}${stderr}`.trim();
}

// Есть ли `.git` (или gitfile) в корне / предках от cwd
export async function isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
	try {
		await git(cwd, ['rev-parse', '--is-inside-work-tree'], signal);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/not a git repository/i.test(msg)) {
			return false;
		}

		// Прочие ошибки git - считаем «не готово», не бросаем
		return false;
	}
}

// Безопасный slug для каталога / имени ветки
export function slugifyWorktreeId(raw: string): string {
	const base = raw.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return base || `wt-${Date.now().toString(36)}`;
}

/**
 * Запустить `worktreeStartCommand` один раз в cwd worktree.
 * Unix: /bin/sh -c; Windows: pwsh -Command (fallback cmd.exe).
 * Ошибка не бросается - возвращает ok/detail.
 */
export async function runWorktreeStartCommand(
	cwd: string,
	command: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
	const trimmed = command.trim();
	if (!trimmed) {
		return { ok: true, detail: '' };
	}

	const invoker = resolveHostShellInvoker();
	const timeoutMs = Math.min(
		getSettings().maxToolTimeoutMs || AGENT_LIMITS.maxCommandTimeoutMs,
		300_000,
	);

	const tryOnce = async (commandBin: string, args: string[]) => {
		const { stdout, stderr } = await execFileAsync(commandBin, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: AGENT_LIMITS.maxCommandOutput,
			signal,
			env: {
				...process.env,
				FORCE_COLOR: '0',
				NO_COLOR: '1',
			},
		});
		const out = previewText(
			[`$ ${trimmed}`, `cwd: ${cwd}`, 'exit: 0', String(stdout ?? ''), String(stderr ?? '')]
				.filter((l) => l.trim())
				.join('\n'),
			AGENT_LIMITS.maxCommandOutput,
		);
		return { ok: true as const, detail: out };
	};

	try {
		return await tryOnce(invoker.command, invoker.argsFor(trimmed));
	} catch (err) {
		const execErr = err as NodeJS.ErrnoException & {
			stdout?: string;
			stderr?: string;
			code?: number | string;
		};
		if (execErr.name === 'AbortError' || signal?.aborted) {
			const abortErr = new Error(vscode.l10n.t('agent.operationCancelled'));
			abortErr.name = 'AbortError';
			throw abortErr;
		}

		if (execErr.code === 'ENOENT' && invoker.fallback) {
			try {
				return await tryOnce(invoker.fallback.command, invoker.fallback.argsFor(trimmed));
			} catch (err2) {
				const execErr2 = err2 as NodeJS.ErrnoException & {
					stdout?: string;
					stderr?: string;
					code?: number | string;
				};
				if (execErr2.name === 'AbortError' || signal?.aborted) {
					const abortErr = new Error(vscode.l10n.t('agent.operationCancelled'));
					abortErr.name = 'AbortError';
					throw abortErr;
				}

				const exit = typeof execErr2.code === 'number' ? execErr2.code : 1;
				const out = previewText(
					[
						`$ ${trimmed}`,
						`cwd: ${cwd}`,
						`exit: ${exit}`,
						String(execErr2.stdout ?? ''),
						String(execErr2.stderr ?? (execErr2 instanceof Error ? execErr2.message : String(execErr2))),
					].filter((l) => String(l).trim()).join('\n'),
					AGENT_LIMITS.maxCommandOutput,
				);
				return {
					ok: false,
					detail: out
				};
			}
		}

		const exit = typeof execErr.code === 'number' ? execErr.code : 1;
		const out = previewText(
			[
				`$ ${trimmed}`,
				`cwd: ${cwd}`,
				`exit: ${exit}`,
				String(execErr.stdout ?? ''),
				String(execErr.stderr ?? (execErr instanceof Error ? execErr.message : String(execErr))),
			]
				.filter((l) => String(l).trim())
				.join('\n'),
			AGENT_LIMITS.maxCommandOutput,
		);
		return { ok: false, detail: out };
	}
}

/**
 * Создать git worktree: сначала `.haratsan/worktrees/<slug>/`, при отказе git - sibling `<repo>.haratsan-worktrees/<slug>` рядом с workspace.
 * Не удаляет worktree после использования (review вручную).
 */
export async function createAgentWorktree(params: {
	/** Идентификатор задачи / тип субагента - для slug */
	taskId: string;
	repoCwd?: string;
	signal?: AbortSignal;
}): Promise<WorktreeCreateResult> {
	const repoCwd = params.repoCwd ?? defaultWorkspaceCwd();
	const signal = params.signal;

	if (!(await isGitRepo(repoCwd, signal))) {
		return {
			ok: false,
			notGitRepo: true,
			detail: 'Не git-репозиторий - worktree пропущен',
		};
	}

	const slug = slugifyWorktreeId(`${params.taskId}-${Date.now().toString(36)}`);
	const primaryPath = path.join(repoCwd, WORKTREES_DIR_RELATIVE, slug);
	const siblingPath = path.join(
		path.dirname(repoCwd),
		`${path.basename(repoCwd)}.haratsan-worktrees`,
		slug,
	);

	const candidates: Array<{
		path: string
		branch: string
	}> = [
		{ 
			path: primaryPath, 
			branch: `haratsan/wt-${slug}` 
		},
		{ 
			path: siblingPath, 
			branch: `haratsan/wt-${slug}-s` 
		},
	];
	const errors: string[] = [];

	for (const { path: worktreePath, branch } of candidates) {
		try {
			await fs.mkdir(path.dirname(worktreePath), { recursive: true });
			// Новая ветка от HEAD; каталог не должен существовать
			const gitOut = await git(
				repoCwd,
				['worktree', 'add', '-b', branch, worktreePath],
				signal,
			);

			const lines = [
				`worktree: ${worktreePath}`,
				`branch: ${branch}`,
				gitOut,
			];

			const startCmd = getSettings().worktreeStartCommand.trim();
			if (startCmd) {
				const started = await runWorktreeStartCommand(worktreePath, startCmd, signal);
				lines.push('startCommand:', started.detail || '(пусто)');
				if (!started.ok) {
					// Soft-fail: worktree уже создан - субагент может работать
					lines.push('(startCommand завершился с ошибкой - продолжаем)');
				}
			}

			return {
				ok: true,
				cwd: worktreePath,
				branch,
				slug,
				detail: lines.filter(Boolean).join('\n'),
			};
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				throw err;
			}
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${worktreePath}: ${msg}`);
		}
	}

	return {
		ok: false,
		detail: `git worktree add: ${errors.join(' | ')}`,
	};
}

/**
 * Нужен ли worktree: явный use_worktree или настройка worktreesEnabled.
 * `use_worktree === false` всегда отключает.
 */
export function shouldUseWorktree(useWorktreeArg: unknown): boolean {
	if (typeof useWorktreeArg === 'boolean') {
		return useWorktreeArg;
	}

	if (typeof useWorktreeArg === 'string') {
		const v = useWorktreeArg.trim().toLowerCase();
		if (v === 'true' || v === '1') {
			return true;
		}
		
		if (v === 'false' || v === '0') {
			return false;
		}
	}
	
	return getSettings().worktreesEnabled === true;
}

export interface AgentWorktreeInfo {
	path: string;
	slug: string;
	branch?: string;
}

// Список worktree под `.haratsan/worktrees/` (+ git worktree list если есть)
export async function listAgentWorktrees(): Promise<AgentWorktreeInfo[]> {
	const root = defaultWorkspaceCwd();
	const dir = path.join(root, WORKTREES_DIR_RELATIVE);
	const out: AgentWorktreeInfo[] = [];
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) {
				continue;
			}

			const full = path.join(dir, e.name);
			let branch: string | undefined;
			try {
				branch = (await git(full, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || undefined;
			} catch {
				branch = undefined;
			}
			out.push({
				path: full,
				slug: e.name,
				branch
			});
		}
	} catch {}

	return out;
}

export async function removeAgentWorktree(worktreePath: string): Promise<boolean> {
	const root = defaultWorkspaceCwd();
	const normalized = path.resolve(worktreePath);
	const base = path.resolve(path.join(root, WORKTREES_DIR_RELATIVE));
	if (!normalized.startsWith(base + path.sep) && normalized !== base) {
		return false;
	}

	try {
		await git(root, ['worktree', 'remove', '--force', normalized]);
		return true;
	} catch {
		try {
			await fs.rm(normalized, {
				recursive: true,
				force: true
			});
			try {
				await git(root, ['worktree', 'prune']);
			} catch {}
			return true;
		} catch {
			return false;
		}
	}
}
