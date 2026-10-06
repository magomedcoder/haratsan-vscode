import * as path from 'node:path';
import * as vscode from 'vscode';
import { discoverLocalPlugins, resolveNpmPluginExecutable } from '../../../project/plugins';
import { asOptionalInt, asString } from '../../types';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';
import { runShellCommand } from '../../shellExec';
import { formatCommandLine } from '../../commandPolicy';
import { confirmAlwaysOrSkip } from '../confirm';
import { pathIsInside } from '../../policy';

// Список локальных `.haratsan/tools` / `.haratsan/plugins` и npm-каталога (без require)
export const listPluginsTool: ToolDefinition = {
	name: 'list_plugins',
	description: 'Список локальных plugins/tools из `.haratsan/plugins`, `.haratsan/tools` и npm-каталога (package.json haratsan/haratsanAgent, `.haratsan/npm-plugins.json`). Манифесты; npm с command/args/bin можно запустить через run_plugin (spawn).',
	parameters: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	async execute(_args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const items = await discoverLocalPlugins();
		return {
			ok: true,
			content: JSON.stringify({
				count: items.length,
				items: items.map((item) => ({
					kind: item.kind,
					name: item.name,
					description: item.description,
					path: item.path,
					hasBody: Boolean(item.body.trim()),
					runnable: Boolean(item.executable),
				})),
			}, null, 2),
		};
	},
};

// Загрузить инструкции локального plugin/tool по имени в контекст
export const pluginTool: ToolDefinition = {
	name: 'plugin',
	description: 'Загрузить описание локального plugin/tool по имени (из `.haratsan/plugins` / `.haratsan/tools` / npm catalog). JS не require в host; для spawn npm см. run_plugin.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Имя plugin или tool',
			},
		},
		required: ['name'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const name = asString(args, 'name').trim().toLowerCase();
		if (!name) {
			return {
				ok: false,
				content: 'plugin: нужен параметр name',
			};
		}

		const items = await discoverLocalPlugins();
		const hit = items.find((item) => item.name.toLowerCase() === name);
		if (!hit) {
			return {
				ok: false,
				content: `Неизвестный plugin/tool "${name}". Доступны: ${items.map((i) => i.name).join(', ') || '(нет)'}`,
			};
		}

		const kindLabel = hit.kind === 'tool' ? 'Tool' : hit.kind === 'npm' ? 'npm' : 'Plugin';
		const body = hit.body.trim() || '(пустое тело - только манифест; открой соседний PLUGIN.md / TOOL.md через read_file)';
		const runNote = hit.executable
			? `\nRunnable: yes (run_plugin). command=${hit.executable.command}`
			: hit.kind === 'npm'
				? '\nRunnable: no (declare command/args or bin in haratsan/haratsanAgent or .haratsan/npm-plugins.json)'
				: '';
		return {
			ok: true,
			content: `# ${kindLabel}: ${hit.name}\nПуть: ${hit.path}\nОписание: ${hit.description}${runNote}\n\n${body}`,
		};
	},
};

function extraArgsFromJson(raw: unknown): string[] {
	if (raw === undefined || raw === null) {
		return [];
	}

	if (Array.isArray(raw)) {
		return raw.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean);
	}

	if (typeof raw === 'string' && raw.trim()) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean);
			}
		} catch {
			return [raw.trim()];
		}
	}

	return [];
}

/**
 * Spawn объявленной команды npm-плагина (только workspace / node_modules). Без require() в extension host.
 * Риски/права shell (confirmAlwaysOrSkip + политика runShellCommand).
 */
export const runPluginTool: ToolDefinition = {
	name: 'run_plugin',
	description: 'Запустить объявленную команду npm-плагина (package.json haratsan/haratsanAgent или `.haratsan/npm-plugins.json`: command/args или bin). Spawn с cwd=workspace, timeout, stdout; без require() в host. Пути вне workspace запрещены.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Имя npm-плагина из каталога',
			},
			args: {
				description: 'Доп. аргументы (массив строк или JSON-массив)',
			},
			timeout_ms: {
				type: 'integer',
				description: 'Таймаут мс (по умолчанию как у shell tools)',
			},
		},
		required: ['name'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const name = asString(args, 'name').trim();
		if (!name) {
			return { 
				ok: false, 
				content: 'run_plugin: нужен параметр name' 
			};
		}

		const hit = await resolveNpmPluginExecutable(name);
		if (!hit?.executable) {
			const items = await discoverLocalPlugins();
			const runnable = items.filter((i) => i.kind === 'npm' && i.executable).map((i) => i.name);
			return {
				ok: false,
				content: `run_plugin: нет runnable npm-плагина "${name}". Доступны: ${runnable.join(', ') || '(нет)'}`,
			};
		}

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return { 
				ok: false, 
				content: 'run_plugin: нет workspace' 
			};
		}

		const workspaceRoot = folder.uri.fsPath;
		const exe = hit.executable;
		if (!pathIsInside(exe.packageRoot, workspaceRoot)) {
			return { 
				ok: false, 
				content: 'run_plugin: packageRoot вне workspace' 
			};
		}

		const extra = extraArgsFromJson(args.args);
		for (const a of extra) {
			if (a.startsWith('-')) {
				continue;
			}

			if (a.includes('/') || a.includes('\\') || path.isAbsolute(a)) {
				const abs = path.isAbsolute(a) ? a : path.resolve(workspaceRoot, a);
				if (!pathIsInside(abs, workspaceRoot)) {
					return { 
						ok: false, 
						content: `run_plugin: аргумент вне workspace: ${a}` 
					};
				}
			}
		}

		const cmdArgs = [...exe.args, ...extra];
		const commandLine = formatCommandLine(exe.command, cmdArgs);
		const denied = await confirmAlwaysOrSkip(
			ctx,
			vscode.l10n.t('agent.confirm.runPlugin', hit.name),
			commandLine,
		);
		if (denied) {
			return denied;
		}

		const timeoutMs = asOptionalInt(args, 'timeout_ms');
		const result = await runShellCommand({
			command: exe.command,
			args: cmdArgs,
			cwd: workspaceRoot,
			timeoutMs: timeoutMs ?? undefined,
			signal: ctx.signal,
		});
		return {
			ok: result.ok,
			content: result.content,
			path: vscode.workspace.asRelativePath(workspaceRoot, false) || '.',
		};
	},
};
