import * as path from 'node:path';
import * as vscode from 'vscode';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { pathExists, resolveWorkspacePath, throwIfAborted } from '../../workspacePath';
import { runShellCommand, formatPartialShellPreview } from '../../shellExec';
import { confirmAlwaysOrSkip } from '../confirm';
import { toPosixRelative } from '../../policy';
import { resolveScriptRunner, supportedScratchExtensions } from '../../scriptRunner';
import { getShellProfileEnv } from '../../../project/shellProfiles';

const SCRATCH_PREFIX = '.haratsan/scratch/';

function isUnderScratch(relative: string): boolean {
	const norm = toPosixRelative(relative).replace(/^\.\//, '');
	return norm === '.haratsan/scratch' || norm.startsWith(SCRATCH_PREFIX);
}

function isBinaryMissing(resultContent: string, command: string): boolean {
	const lower = resultContent.toLowerCase();
	return (lower.includes('enoent') || lower.includes('not found') || lower.includes(`'${command.toLowerCase()}'`) || lower.includes(`"${command.toLowerCase()}"`));
}

// Запуск одноразового скрипта только из `.haratsan/scratch/**` (не eval произвольного JS)
export const runScratchTool: ToolDefinition = {
	name: 'run_scratch',
	description: 'Запустить файл из `.haratsan/scratch/` (node/python/bash/pwsh по расширению, включая .ps1). Только пути под `.haratsan/scratch/**`; с подтверждением.',
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Путь относительно workspace, обязан быть под `.haratsan/scratch/`',
			},
			args: {
				type: 'array',
				items: { type: 'string' },
				description: 'Аргументы скрипту',
			},
			timeout_ms: {
				type: 'integer',
				description: 'Таймаут мс (по умолчанию как у run_command)',
			},
			profile: {
				type: 'string',
				description: 'Имя профиля из `.haratsan/shell.json`',
			},
		},
		required: ['path'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const resolved = await resolveWorkspacePath(asString(args, 'path'));
		const relative = toPosixRelative(resolved.relative);

		if (!isUnderScratch(relative)) {
			return {
				ok: false,
				denied: true,
				path: relative,
				content: `run_scratch: путь должен быть под ${SCRATCH_PREFIX}** (получено: ${relative})`,
			};
		}

		if (!(await pathExists(resolved.uri))) {
			return {
				ok: false,
				path: relative,
				content: vscode.l10n.t('tool.fileNotFound', relative),
			};
		}

		const ext = path.posix.extname(relative).toLowerCase();
		const runner = resolveScriptRunner(ext);
		if (!runner) {
			return {
				ok: false,
				path: relative,
				content: `run_scratch: расширение «${ext || '(нет)'}» не поддерживается (ожидаются ${supportedScratchExtensions().join(', ')})`,
			};
		}

		const scriptArgs = Array.isArray(args.args)
			? args.args.filter((item): item is string => typeof item === 'string')
			: [];
		const timeoutMs = asOptionalInt(args, 'timeout_ms');
		const scriptFsPath = resolved.uri.fsPath;
		const cwd = resolved.folder.uri.fsPath;

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

		const tryRun = async (command: string, argsPrefix: string[]) => {
			const commandLine = `${command} ${[...argsPrefix, relative, ...scriptArgs].join(' ')}`;
			const denied = await confirmAlwaysOrSkip(
				ctx,
				vscode.l10n.t('agent.confirm.runCommand', relative),
				commandLine,
			);
			if (denied) {
				return {
					denied: true as const,
					result: {
						...denied,
						path: relative,
					},
				};
			}

			const result = await runShellCommand({
				command,
				args: [...argsPrefix, scriptFsPath, ...scriptArgs],
				cwd,
				timeoutMs,
				signal: ctx.signal,
				allowDeniedBinary: true,
				env: profileEnv.env,
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

			return {
				denied: false as const,
				result: {
					ok: result.ok,
					path: relative,
					content: result.content,
				},
				command,
			};
		};

		const primary = await tryRun(runner.command, runner.argsPrefix);
		if (primary.denied) {
			return primary.result;
		}

		if (!primary.result.ok && runner.fallback && isBinaryMissing(primary.result.content, runner.command)) {
			const fallback = await tryRun(runner.fallback.command, runner.fallback.argsPrefix);
			if (fallback.denied) {
				return fallback.result;
			}

			return fallback.result;
		}

		return primary.result;
	},
};
