import * as path from 'node:path';
import * as vscode from 'vscode';

function pathIsInside(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Локальные plugins/tools + npm-каталог с осторожным runtime execute.
 *
 * Конвенция:
 * - Инструменты:
 *   - `.haratsan/tools/<name>.md` - однофайловое описание (YAML frontmatter: name, description)
 *   - `.haratsan/tools/<name>/TOOL.md` - пакет в папке
 * - Плагины:
 *   - `.haratsan/plugins/<name>/plugin.json` - манифест (обязательная точка обнаружения) { "name"?, "description"?, "instructions"? }
 *   - если `instructions` пуст - тело берётся из соседнего `PLUGIN.md`
 * - npm:
 *   - `package.json` с полем `haratsan` / `haratsanAgent`
 *   - `.haratsan/npm-plugins.json` - список `{ "name", "description"?, "package"?, "command"?, "args"?, "bin"? }` или строк
 *   - execute: только spawn объявленной команды под workspace / node_modules (tool `run_plugin`); без require() в host
 */

export type LocalPluginKind = 'tool' | 'plugin' | 'npm';

// Объявленный spawn для npm-плагина (пути должны резолвиться под workspace)
export interface NpmPluginExecutable {
	command: string;
	args: string[];
	// Абсолютный корень пакета для резолва относительных args (под workspace)
	packageRoot: string;
}

export interface LocalPluginInfo {
	kind: LocalPluginKind;
	name: string;
	description: string;
	// Путь к главному файлу (md или plugin.json) относительно workspace
	path: string;
	body: string;
	// Только kind=npm: объявленная команда для run_plugin
	executable?: NpmPluginExecutable;
}

const MAX_BODY_CHARS = 16_000;
const MAX_ITEMS = 60;

const TOOL_GLOBS = [
	'.haratsan/tools/*.md',
	'.haratsan/tools/*/TOOL.md',
];

const PLUGIN_GLOB = '.haratsan/plugins/*/plugin.json';

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw.trim());
	if (!match) {
		return { body: raw.trim() };
	}

	const meta = match[1]!;
	const body = match[2]!.trim();
	const name = /^\s*name:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const description = /^\s*description:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	return { name, description, body };
}

function truncateBody(body: string): string {
	if (body.length <= MAX_BODY_CHARS) {
		return body;
	}

	return `${body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
}

function folderNameFromUri(uri: vscode.Uri): string {
	const parts = uri.path.split('/').filter(Boolean);
	return parts[parts.length - 2] ?? 'item';
}

function fileStem(uri: vscode.Uri): string {
	const base = uri.path.split('/').pop() ?? 'item';
	return base.replace(/\.md$/i, '');
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

async function readToolMd(uri: vscode.Uri, seen: Set<string>, out: LocalPluginInfo[]): Promise<void> {
	const raw = await readText(uri);
	if (raw === undefined) {
		return;
	}

	const parsed = parseFrontmatter(raw);
	const isToolFile = /\/TOOL\.md$/i.test(uri.path);
	const name = (parsed.name || (isToolFile ? folderNameFromUri(uri) : fileStem(uri))).trim();
	const key = name.toLowerCase();
	if (!name || seen.has(key)) {
		return;
	}

	seen.add(key);
	out.push({
		kind: 'tool',
		name,
		description: parsed.description || name,
		path: vscode.workspace.asRelativePath(uri),
		body: truncateBody(parsed.body),
	});
}

interface PluginManifest {
	name?: string;
	description?: string;
	instructions?: string;
}

function parsePluginJson(raw: string): PluginManifest | undefined {
	try {
		const data = JSON.parse(raw) as unknown;
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			return undefined;
		}

		const obj = data as Record<string, unknown>;
		return {
			name: typeof obj.name === 'string' ? obj.name.trim() : undefined,
			description: typeof obj.description === 'string' ? obj.description.trim() : undefined,
			instructions: typeof obj.instructions === 'string' ? obj.instructions : undefined,
		};
	} catch {
		return undefined;
	}
}

async function readPluginJson(uri: vscode.Uri, seen: Set<string>, out: LocalPluginInfo[]): Promise<void> {
	const raw = await readText(uri);
	if (raw === undefined) {
		return;
	}

	const manifest = parsePluginJson(raw);
	if (!manifest) {
		return;
	}

	const folder = folderNameFromUri(uri);
	const name = (manifest.name || folder).trim();
	const key = name.toLowerCase();
	if (!name || seen.has(key)) {
		return;
	}

	let body = (manifest.instructions ?? '').trim();
	if (!body) {
		const parts = uri.path.split('/');
		parts[parts.length - 1] = 'PLUGIN.md';
		const pluginMd = uri.with({ path: parts.join('/') });
		const mdRaw = await readText(pluginMd);
		if (mdRaw !== undefined) {
			const parsed = parseFrontmatter(mdRaw);
			body = parsed.body;
			if (!manifest.description && parsed.description) {
				manifest.description = parsed.description;
			}
		}
	}

	seen.add(key);
	out.push({
		kind: 'plugin',
		name,
		description: manifest.description || name,
		path: vscode.workspace.asRelativePath(uri),
		body: truncateBody(body),
	});
}

function pushNpmEntry(
	seen: Set<string>,
	out: LocalPluginInfo[],
	entry: {
		name: string;
		description?: string;
		path: string;
		body?: string;
		executable?: NpmPluginExecutable;
	},
): void {
	const name = entry.name.trim();
	const key = `npm:${name.toLowerCase()}`;
	if (!name || seen.has(key) || out.length >= MAX_ITEMS) {
		return;
	}

	seen.add(key);
	const canRun = Boolean(entry.executable);
	out.push({
		kind: 'npm',
		name,
		description: (entry.description || name).trim(),
		path: entry.path,
		body: truncateBody(
			entry.body?.trim()
			|| (canRun
				? `(npm plugin) run via tool run_plugin; no require() into extension host.`
				: '(npm plugin catalog only - declare command/args or bin for run_plugin)'),
		),
		...(entry.executable ? { executable: entry.executable } : {}),
	});
}

interface ParsedHaratsanPluginField {
	name: string;
	description?: string;
	command?: string;
	args?: string[];
	bin?: string;
}

function parseHaratsanPluginField(raw: unknown, pkgName: string): ParsedHaratsanPluginField | undefined {
	if (typeof raw === 'string' && raw.trim()) {
		return { name: raw.trim(), description: `npm package ${pkgName}` };
	}

	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === 'string' && obj.name.trim()
		? obj.name.trim()
		: pkgName.trim();
	if (!name) {
		return undefined;
	}

	const description = typeof obj.description === 'string' ? obj.description.trim() : undefined;
	const command = typeof obj.command === 'string' && obj.command.trim()
		? obj.command.trim()
		: undefined;
	const args = Array.isArray(obj.args)
		? obj.args.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean)
		: undefined;
	const bin = typeof obj.bin === 'string' && obj.bin.trim()
		? obj.bin.trim()
		: undefined;
	return {
		name,
		description: description || `npm package ${pkgName}`,
		...(command ? { command } : {}),
		...(args && args.length ? { args } : {}),
		...(bin ? { bin } : {}),
	};
}

function workspaceRootFs(folder: vscode.WorkspaceFolder): string {
	return folder.uri.fsPath;
}

function assertPathInsideWorkspace(absPath: string, workspaceRoot: string): string {
	const resolved = path.resolve(absPath);
	if (!pathIsInside(resolved, workspaceRoot)) {
		throw new Error(`path outside workspace: ${resolved}`);
	}

	return resolved;
}

async function resolveBinFromPackage(
	packageRoot: string,
	binName: string | undefined,
	workspaceRoot: string,
): Promise<{ command: string; args: string[] } | undefined> {
	const pkgRaw = await readText(vscode.Uri.file(path.join(packageRoot, 'package.json')));
	if (pkgRaw === undefined) {
		return undefined;
	}

	try {
		const data = JSON.parse(pkgRaw) as Record<string, unknown>;
		const binField = data.bin;
		let scriptRel: string | undefined;
		if (typeof binField === 'string' && binField.trim()) {
			scriptRel = binField.trim();
		} else if (binField && typeof binField === 'object' && !Array.isArray(binField)) {
			const map = binField as Record<string, unknown>;
			const preferred = binName?.trim();
			if (preferred && typeof map[preferred] === 'string') {
				scriptRel = String(map[preferred]).trim();
			} else {
				const first = Object.values(map).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
				scriptRel = first?.trim();
			}
		}
		if (!scriptRel) {
			return undefined;
		}

		const scriptAbs = assertPathInsideWorkspace(path.resolve(packageRoot, scriptRel), workspaceRoot);
		return { command: 'node', args: [scriptAbs] };
	} catch {
		return undefined;
	}
}

/**
 * Собрать spawn-спеку executable. Относительные args резолвятся под packageRoot; все пути к файлам - внутри workspace.
 * Command: бинарь из PATH (node) или абсолютный/относительный путь под workspace.
 */
export function buildNpmPluginExecutable(params: {
	workspaceRoot: string;
	packageRoot: string;
	command?: string;
	args?: string[];
}): NpmPluginExecutable {
	const workspaceRoot = path.resolve(params.workspaceRoot);
	const packageRoot = assertPathInsideWorkspace(params.packageRoot, workspaceRoot);
	const commandRaw = (params.command ?? 'node').trim();
	if (!commandRaw) {
		throw new Error('empty command');
	}

	let command = commandRaw;
	if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) {
		command = assertPathInsideWorkspace(
			path.isAbsolute(command) ? command : path.resolve(packageRoot, command),
			workspaceRoot,
		);
	}

	const args = (params.args ?? []).map((arg) => {
		const a = arg.trim();
		if (!a) {
			return a;
		}

		// Резолв относительных file-like args относительно корня пакета; флаги без изменений
		if (a.startsWith('-')) {
			return a;
		}

		if (a.includes('/') || a.includes('\\') || /\.\w{1,10}$/.test(a) || path.isAbsolute(a)) {
			const abs = path.isAbsolute(a) ? a : path.resolve(packageRoot, a);
			return assertPathInsideWorkspace(abs, workspaceRoot);
		}
		return a;
	});

	return { command, args, packageRoot };
}

async function discoverNpmPluginsFromPackageJson(
	folder: vscode.WorkspaceFolder,
	seen: Set<string>,
	out: LocalPluginInfo[],
): Promise<void> {
	const workspaceRoot = workspaceRootFs(folder);
	const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
	const raw = await readText(pkgUri);
	if (raw === undefined) {
		return;
	}

	try {
		const data = JSON.parse(raw) as Record<string, unknown>;
		const pkgName = typeof data.name === 'string' ? data.name : 'package';
		const fieldKey = (['haratsan', 'haratsanAgent'] as const).find((k) => data[k] !== undefined);
		const field = fieldKey ? data[fieldKey] : undefined;
		const parsed = parseHaratsanPluginField(field, pkgName);
		if (!parsed || !fieldKey) {
			return;
		}

		let executable: NpmPluginExecutable | undefined;
		try {
			if (parsed.command || parsed.args?.length) {
				executable = buildNpmPluginExecutable({
					workspaceRoot,
					packageRoot: workspaceRoot,
					command: parsed.command,
					args: parsed.args,
				});
			} else if (parsed.bin || field && typeof field === 'object') {
				const fromBin = await resolveBinFromPackage(workspaceRoot, parsed.bin, workspaceRoot);
				if (fromBin) {
					executable = buildNpmPluginExecutable({
						workspaceRoot,
						packageRoot: workspaceRoot,
						command: fromBin.command,
						args: fromBin.args,
					});
				}
			}
		} catch {
			executable = undefined;
		}

		pushNpmEntry(seen, out, {
			name: parsed.name,
			description: parsed.description,
			path: 'package.json',
			body: executable
				? `Объявлено в package.json (${fieldKey}). Запуск: tool run_plugin (spawn, без require).`
				: `Объявлено в package.json (${fieldKey}). Добавь command/args или bin для run_plugin.`,
			executable,
		});
	} catch {}
}

async function discoverNpmPluginsList(
	folder: vscode.WorkspaceFolder,
	seen: Set<string>,
	out: LocalPluginInfo[],
): Promise<void> {
	const workspaceRoot = workspaceRootFs(folder);
	const listUri = vscode.Uri.joinPath(folder.uri, '.haratsan', 'npm-plugins.json');
	const raw = await readText(listUri);
	if (raw === undefined) {
		return;
	}

	try {
		const data = JSON.parse(raw) as unknown;
		const items = Array.isArray(data)
			? data
			: data && typeof data === 'object' && Array.isArray((data as { plugins?: unknown }).plugins)
				? (data as { plugins: unknown[] }).plugins
				: [];
		for (const item of items) {
			if (typeof item === 'string' && item.trim()) {
				const pkgName = item.trim();
				const packageRoot = path.join(workspaceRoot, 'node_modules', pkgName);
				let executable: NpmPluginExecutable | undefined;
				try {
					const fromBin = await resolveBinFromPackage(packageRoot, undefined, workspaceRoot);
					if (fromBin) {
						executable = buildNpmPluginExecutable({
							workspaceRoot,
							packageRoot,
							command: fromBin.command,
							args: fromBin.args,
						});
					}
				} catch {
					executable = undefined;
				}
				pushNpmEntry(seen, out, {
					name: pkgName,
					path: '.haratsan/npm-plugins.json',
					executable,
				});
				continue;
			}

			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				continue;
			}

			const row = item as Record<string, unknown>;
			const name = typeof row.name === 'string' ? row.name.trim() : '';
			if (!name) {
				continue;
			}

			const packageName = typeof row.package === 'string' && row.package.trim()
				? row.package.trim()
				: name;
			const description = typeof row.description === 'string'
				? row.description.trim()
				: `package ${packageName}`;
			const packageRoot = path.join(workspaceRoot, 'node_modules', packageName);
			const command = typeof row.command === 'string' ? row.command.trim() : undefined;
			const args = Array.isArray(row.args)
				? row.args.filter((a): a is string => typeof a === 'string')
				: undefined;
			const bin = typeof row.bin === 'string' ? row.bin.trim() : undefined;

			let executable: NpmPluginExecutable | undefined;
			try {
				if (command || args?.length) {
					executable = buildNpmPluginExecutable({
						workspaceRoot,
						packageRoot,
						command,
						args,
					});
				} else {
					const fromBin = await resolveBinFromPackage(packageRoot, bin, workspaceRoot);
					if (fromBin) {
						executable = buildNpmPluginExecutable({
							workspaceRoot,
							packageRoot,
							command: fromBin.command,
							args: fromBin.args,
						});
					}
				}
			} catch {
				executable = undefined;
			}

			pushNpmEntry(seen, out, {
				name,
				description,
				path: '.haratsan/npm-plugins.json',
				executable,
			});
		}
	} catch {}
}

// Резолв executable npm-плагина по имени из каталога (для run_plugin)
export async function resolveNpmPluginExecutable(name: string): Promise<LocalPluginInfo | undefined> {
	const items = await discoverLocalPlugins();
	const key = name.trim().toLowerCase();
	return items.find((item) => item.kind === 'npm' && item.name.toLowerCase() === key && item.executable);
}

// Обнаружить локальные tools (`.haratsan/tools`) и plugins (`.haratsan/plugins`) + npm catalog
export async function discoverLocalPlugins(): Promise<LocalPluginInfo[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const out: LocalPluginInfo[] = [];
	const seen = new Set<string>();

	for (const glob of TOOL_GLOBS) {
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, glob),
			undefined,
			MAX_ITEMS,
		);
		for (const uri of uris) {
			// не подхватывать TOOL.md через `*.md` в корне tools (нет: *.md только один уровень)
			await readToolMd(uri, seen, out);
			if (out.length >= MAX_ITEMS) {
				return out.sort(comparePlugins);
			}
		}
	}

	const pluginUris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, PLUGIN_GLOB),
		undefined,
		MAX_ITEMS,
	);
	for (const uri of pluginUris) {
		await readPluginJson(uri, seen, out);
		if (out.length >= MAX_ITEMS) {
			return out.sort(comparePlugins);
		}
	}

	await discoverNpmPluginsFromPackageJson(folder, seen, out);
	if (out.length < MAX_ITEMS) {
		await discoverNpmPluginsList(folder, seen, out);
	}

	return out.sort(comparePlugins);
}

function comparePlugins(a: LocalPluginInfo, b: LocalPluginInfo): number {
	const order = (k: LocalPluginKind) => (k === 'tool' ? 0 : k === 'plugin' ? 1 : 2);
	if (a.kind !== b.kind) {
		return order(a.kind) - order(b.kind);
	}

	return a.name.localeCompare(b.name, 'ru');
}

// Каталог для system prompt (RU)
export function formatPluginsCatalog(items: LocalPluginInfo[]): string | undefined {
	if (items.length === 0) {
		return undefined;
	}

	const lines = items.map((item) => {
		const label = item.kind === 'tool' ? 'tool' : item.kind === 'plugin' ? 'plugin' : 'npm';
		const runHint = item.kind === 'npm' && item.executable ? ' [run_plugin]' : '';
		return `- [${label}] ${item.name}: ${item.description} (${item.path})${runHint}`;
	});
	return [
		'Локальные plugins/tools (описание; JS не require в host).',
		'npm с command/args/bin: tool run_plugin (spawn под workspace, с подтверждением shell).',
		'Tools из `.haratsan/tools` также доступны как LLM tools по имени (registry).',
		'Иначе загрузи инструкции через tool plugin по имени или read_file:',
		...lines,
	].join('\n');
}
