import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_HARATSANIGNORE_PATTERNS, DEFAULT_SENSITIVE_PATH_PATTERNS, EXAMPLE_DENIED_COMMANDS } from '../../core/config/types';

export const HARATSAN_DIR_RELATIVE = '.haratsan';
export const HARATSAN_CONFIG_RELATIVE = '.haratsan/config.json';
export const HARATSAN_IGNORE_RELATIVE = '.haratsanignore';
export const HARATSAN_CONFIG_VERSION = 1;

const HARATSAN_IGNORE_CONTENT = `# .haratsanignore - пути/папки, недоступные агенту Haratsan
# Синтаксис как у .gitignore. Не путать с .haratsan/config.json (команды / redact).
#
${DEFAULT_HARATSANIGNORE_PATTERNS.join('\n')}
`;

/**
 * Каталоги MVP под `.haratsan/` - создаются командой `haratsan.initProject` и `/init`.
 * Индекс кодовой базы в workspace storage и не требует `.haratsan/`.
 * `references.json` пишется по требованию (не здесь).
 */
export const HARATSAN_SCAFFOLD_DIRS = ['agents', 'commands', 'plugins', 'skills', 'tools', 'references', 'plans', 'scratch'] as const;

// Краткое описание layout `.haratsan/` (RU + EN); не перезаписываем, если уже есть
const HARATSAN_README_CONTENT = `# \`.haratsan/\` - Haratsan

Project files for Haratsan / файлы проекта Haratsan.

| Dir | EN | RU |
| --- | --- | --- |
| \`agents/\` | Custom agents (\`*.md\`) | Кастомные агенты |
| \`commands/\` | Slash commands (\`*.md\`) | Slash-команды |
| \`plugins/\` | \`*/plugin.json\` (+ optional \`PLUGIN.md\`) | Локальные плагины |
| \`skills/\` | Skills (\`SKILL.md\`) | Skills |
| \`tools/\` | \`*.md\` or \`*/TOOL.md\` | Локальные tools |
| \`references/\` | Per-alias reference JSON | JSON ссылок по alias |
| \`plans/\` | Multi-file plans | Планы агента |
| \`scratch/\` | Ephemeral scripts (\`run_scratch\`) | Одноразовые скрипты |

Also under workspace root: \`.haratsanignore\` (ignore paths/folders for the agent; gitignore syntax).

Inside \`.haratsan/\`: \`config.json\` (\`deniedCommands\`, \`sensitivePathPatterns\`, \`secretPatterns\`, other settings - not path ignore), \`hooks.json\`, \`shell.json\`, \`references.json\` (on demand), \`plan.md\`.

Path/folder ignore -> edit \`.haratsanignore\` (not \`config.json\`).
Commands / redact patterns -> edit \`.haratsan/config.json\` by hand (not Settings UI).

Index / project map caches live in VS Code workspace storage (\`storageUri\`), not under \`.haratsan/\`.
`;

/**
 * Project `.haratsan/config.json`: маркер наличия project-слоя + опциональный overlay HaratsanSettings.
 * Известные ключи мержатся в effective config (см. `src/config/layers.ts`, FILE_LAYER_KEYS).
 * Не нужен для фоновой индексации.
 */
export interface HaratsanProjectConfig {
	version: number;
	createdAt: string;
	// Путь к hooks.json (относительно workspace или абсолютный)
	hooksPath?: string;
	// Inline-хуки (как в hooks.json)
	hooks?: Record<string, unknown>;
	// Прочие известные ключи HaratsanSettings
	[key: string]: unknown;
}

function folderFsPath(explicit?: string): string | undefined {
	return explicit ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// Записать файл только если его ещё нет (не перезаписывать)
async function writeIfMissing(filePath: string, content: string): Promise<void> {
	try {
		await fs.access(filePath);
	} catch {
		await fs.writeFile(filePath, content, 'utf8');
	}
}

/**
 * Создать каталоги `.haratsan/{agents,commands,...}` + `.gitkeep` и краткий README.
 * Идемпотентно: существующие файлы не трогаем.
 */
export async function ensureHaratsanScaffold(folderPath?: string): Promise<void> {
	const root = folderFsPath(folderPath);
	if (!root) {
		return;
	}

	const haratsanRoot = path.join(root, HARATSAN_DIR_RELATIVE);
	await fs.mkdir(haratsanRoot, { recursive: true });
	await writeIfMissing(path.join(haratsanRoot, 'README.md'), HARATSAN_README_CONTENT);

	for (const dir of HARATSAN_SCAFFOLD_DIRS) {
		const dirPath = path.join(haratsanRoot, dir);
		await fs.mkdir(dirPath, { recursive: true });
		await writeIfMissing(path.join(dirPath, '.gitkeep'), '');
	}
}

// Есть ли `.haratsan/config.json` (project overlay / hooks / agents scaffold)
export async function isProjectEnabled(folderPath?: string): Promise<boolean> {
	const root = folderFsPath(folderPath);
	if (!root) {
		return false;
	}

	try {
		await fs.access(path.join(root, HARATSAN_CONFIG_RELATIVE));
		return true;
	} catch {
		return false;
	}
}

export async function enableProject(folderPath?: string): Promise<vscode.WorkspaceFolder | undefined> {
	const folder = folderPath
		? vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === folderPath)
		: vscode.workspace.workspaceFolders?.[0];

	if (!folder) {
		return undefined;
	}

	const root = folder.uri.fsPath;
	await ensureHaratsanScaffold(root);
	await writeIfMissing(path.join(root, HARATSAN_IGNORE_RELATIVE), HARATSAN_IGNORE_CONTENT);

	const configPath = path.join(root, HARATSAN_CONFIG_RELATIVE);
	try {
		await fs.access(configPath);
	} catch {
		const config: HaratsanProjectConfig = {
			version: HARATSAN_CONFIG_VERSION,
			createdAt: new Date().toISOString(),
			// Команды / redact / sensitive write - не path-ignore (path-ignore = .haratsanignore)
			sensitivePathPatterns: [...DEFAULT_SENSITIVE_PATH_PATTERNS],
			deniedCommands: [...EXAMPLE_DENIED_COMMANDS],
			secretPatterns: [],
		};
		await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
	}

	return folder;
}
