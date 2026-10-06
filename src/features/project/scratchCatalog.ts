import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HARATSAN_DIR_RELATIVE } from './config';

const SCRATCH_REL = `${HARATSAN_DIR_RELATIVE}/scratch`;
const MAX_LIST = 24;

// Краткий каталог файлов `.haratsan/scratch/` для system prompt appendix.
export async function formatScratchCatalog(): Promise<string | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		return undefined;
	}

	const dir = path.join(root, SCRATCH_REL);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return undefined;
	}

	const files = names
		.filter((n) => n && n !== '.gitkeep' && !n.startsWith('.'))
		.sort()
		.slice(0, MAX_LIST);

	if (files.length === 0) {
		return undefined;
	}

	const lines = [
		'Scratch (`.haratsan/scratch/`): одноразовые скрипты; запуск только через `run_scratch` (не eval). Файлы:',
		...files.map((f) => `- ${SCRATCH_REL}/${f}`),
	];
	if (names.length > MAX_LIST) {
		lines.push(`... и ещё ${names.length - MAX_LIST}`);
	}

	return lines.join('\n');
}
