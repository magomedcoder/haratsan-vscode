import * as vscode from 'vscode';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { resolveCommandCwd, throwIfAborted } from '../../workspacePath';
import { runShellCommand, formatPartialShellPreview } from '../../shellExec';
import { formatCommandLine } from '../../commandPolicy';
import { confirmAlwaysOrSkip } from '../confirm';
import type { ShellSession } from '../../shellSession';
import { runBeforeShellHook, runShellEnvHook } from '../../../project/hooks';
import { getShellProfileEnv, mergeEnvLayers } from '../../../project/shellProfiles';

function asStringArray(args: Record<string, unknown>, key: string): string[] {
	const value = args[key];
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === 'string');
}

export const runCommandTool: ToolDefinition = {
	name: 'run_command',
	description: 'Запустить команду в workspace через execFile (без shell/pipe). cwd сохраняется между вызовами. background=true - вернуть job_id для await_shell.',
	parameters: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'Исполняемый файл (go, python, npm, ...)',
			},
			args: {
				type: 'array',
				items: { type: 'string' },
				description: 'Аргументы команды',
			},
			cwd: {
				type: 'string',
				description: 'Рабочий каталог относительно текущего shell cwd / workspace',
			},
			timeout_ms: {
				type: 'integer',
				description: 'Таймаут в миллисекундах (по умолчанию 60000, максимум 300000)',
			},
			background: {
				type: 'boolean',
				description: 'Запустить в фоне и вернуть job_id',
			},
			profile: {
				type: 'string',
				description: 'Имя профиля из `.haratsan/shell.json` (иначе defaultProfile / HARATSAN_SHELL_PROFILE)',
			},
		},
		required: ['command'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const shell = (ctx as ToolContext & { shell?: ShellSession }).shell;
		const command = asString(args, 'command').trim();
		const cmdArgs = asStringArray(args, 'args');
		const timeoutMs = asOptionalInt(args, 'timeout_ms');
		const background = args.background === true;

		let cwd: string;
		let relative: string;
		if (shell) {
			cwd = shell.resolveCwd(asString(args, 'cwd', ''));
			relative = vscode.workspace.asRelativePath(cwd, false);
		} else {
			const resolved = await resolveCommandCwd(asString(args, 'cwd', '.'));
			cwd = resolved.cwd;
			relative = resolved.relative;
		}

		const commandLine = formatCommandLine(command, cmdArgs);
		const denied = await confirmAlwaysOrSkip(ctx, vscode.l10n.t('agent.confirm.runCommand', relative || '.'), commandLine);
		if (denied) {
			return {
				...denied,
				path: relative,
			};
		}

		const hook = await runBeforeShellHook(commandLine, ctx.signal);
		if (hook.vetoed) {
			return {
				ok: false,
				denied: true,
				path: relative,
				content: hook.stderr?.trim() || vscode.l10n.t('chat.hooks.veto', 'beforeShell', commandLine),
			};
		}

		// shell.env: inject/modify env или veto перед spawn
		const envHook = await runShellEnvHook(commandLine, cwd, ctx.signal);
		if (envHook.vetoed) {
			return {
				ok: false,
				denied: true,
				path: relative,
				content: envHook.stderr?.trim() || vscode.l10n.t('chat.hooks.veto', 'shell.env', commandLine),
			};
		}

		const profileEnv = await getShellProfileEnv({
			profileName: asString(args, 'profile', ''),
		});
		if (profileEnv.error) {
			return {
				ok: false,
				path: relative,
				content: `shell profile: ${profileEnv.error}`,
			};
		}

		// Profile -> hook (hook перекрывает)
		const envExtra = mergeEnvLayers(profileEnv.env, envHook.env);

		if (background) {
			if (!shell) {
				return {
					ok: false,
					content: 'background: недоступна shell-сессия'
				};
			}

			const job = shell.startBackground(command, cmdArgs, cwd, ctx.signal, envExtra);
			shell.applyCd(command, cmdArgs);
			return {
				ok: true,
				path: relative,
				content: JSON.stringify({
					job_id: job.id,
					command: job.commandLine,
					cwd: job.cwd,
					hint: 'Вызови await_shell с этим job_id',
				}, null, 2),
			};
		}

		const result = await runShellCommand({
			command,
			args: cmdArgs,
			cwd,
			timeoutMs,
			signal: ctx.signal,
			env: envExtra,
			onPartialOutput: ctx.onPartialOutput
				? (raw) => {
					ctx.onPartialOutput!(
						formatPartialShellPreview({
							commandLine,
							cwd,
							raw,
						}),
					);
				}
				: undefined,
		});
		if (shell && result.ok) {
			shell.applyCd(command, cmdArgs);
		}

		return {
			ok: result.ok,
			path: relative,
			content: result.content,
		};
	},
};
