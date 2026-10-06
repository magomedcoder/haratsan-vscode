import * as vscode from 'vscode';
import type { SubagentDef } from '../agent/subagents';

const AGENTS_GLOB = '.haratsan/agents/*.md';
const MAX_BODY_CHARS = 12_000;

export interface BuiltinAgentPreset {
	id: string;
	name: string;
	description: string;
	readonly: boolean;
	mode?: string;
	body: string;
}

export const BUILTIN_PRESETS: BuiltinAgentPreset[] = [
	{
		id: 'docs-researcher',
		name: 'docs-researcher',
		description: 'Исследование внешней документации: web_search, fetch_page, search_docs.',
		readonly: true,
		mode: 'ask',
		body: [
			'# docs-researcher',
			'',
			'Ты исследователь документации. Цель - найти и кратко изложить факты из внешних docs.',
			'',
			'## Инструкции',
			'',
			'- Используй web_search, fetch_page, search_docs и read-only tools.',
			'- Не правь файлы и не запускай мутирующие команды.',
			'- Цитируй URL и ключевые фрагменты; в конце - сжатый отчёт.',
		].join('\n'),
	},
	{
		id: 'code-reviewer',
		name: 'code-reviewer',
		description: 'Ревью кода: риски, баги, стиль; только чтение.',
		readonly: true,
		mode: 'ask',
		body: [
			'# code-reviewer',
			'',
			'Ты code-reviewer. Ищи баги, риски безопасности, регрессии и пробелы в тестах.',
			'',
			'## Инструкции',
			'',
			'- Читай релевантные файлы (read/grep/glob/codebase_search).',
			'- Не вноси правки - только отчёт с приоритетами (blocker / major / nit).',
			'- Указывай пути и краткие обоснования.',
		].join('\n'),
	},
];

const RESERVED_AGENT_IDS = new Set(['explore', 'general', 'scout']);

function parseFrontmatter(raw: string): {
	name?: string;
	description?: string;
	mode?: string;
	model?: string;
	readonly?: boolean;
	body: string;
} {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw.trim());
	if (!match) {
		return { 
			body: raw.trim() 
		};
	}

	const meta = match[1]!;
	const body = match[2]!.trim();
	const name = /^\s*name:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const description = /^\s*description:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const mode = /^\s*mode:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const model = /^\s*model:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const readonlyRaw = /^\s*readonly:\s*(.+)$/m.exec(meta)?.[1]?.trim().toLowerCase();
	const readonly = readonlyRaw === 'true' || readonlyRaw === 'yes' || readonlyRaw === '1';
	return { 
		name, 
		description, 
		mode, 
		model, 
		readonly, 
		body 
	};
}

function slugifyAgentName(name: string): string {
	return name.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9_-]/g, '')
		.slice(0, 48) || 'agent';
}

function presetToSubagent(preset: BuiltinAgentPreset): SubagentDef {
	return {
		id: preset.id,
		name: preset.name,
		description: preset.description,
		readonly: preset.readonly,
		maxIterations: 16,
		prompt: [
			`Ты builtin-агент «${preset.name}».`,
			preset.body,
		].join('\n\n'),
	};
}

export function getBuiltinPreset(id: string): BuiltinAgentPreset | undefined {
	const needle = id.trim().toLowerCase();
	return BUILTIN_PRESETS.find((p) => p.id === needle || p.name.toLowerCase() === needle);
}

export function resolveBuiltinPresetSubagent(id: string): SubagentDef | undefined {
	const preset = getBuiltinPreset(id);
	return preset ? presetToSubagent(preset) : undefined;
}

// Разобрать markdown кастомного агента из `.haratsan/agents/`
export async function discoverCustomAgents(): Promise<SubagentDef[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, AGENTS_GLOB), undefined, 40);
	const out: SubagentDef[] = [];
	const seen = new Set<string>();

	for (const uri of uris) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const raw = new TextDecoder().decode(bytes);
			const parsed = parseFrontmatter(raw);
			const fileBase = (uri.path.split('/').pop() ?? 'agent').replace(/\.md$/i, '');
			const name = (parsed.name || fileBase).trim();
			const id = slugifyAgentName(name);
			if (seen.has(id) || RESERVED_AGENT_IDS.has(id)) {
				continue;
			}

			seen.add(id);
			const body = parsed.body.length > MAX_BODY_CHARS
				? `${parsed.body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`
				: parsed.body;
			const modeHint = parsed.mode ? ` Режим: ${parsed.mode}.` : '';
			const modelHint = parsed.model ? ` Модель (подсказка): ${parsed.model}.` : '';
			out.push({
				id,
				name,
				description: parsed.description || name,
				readonly: parsed.readonly === true,
				maxIterations: 16,
				prompt: [
					`Ты кастомный субагент «${name}».${modeHint}${modelHint}`,
					body || 'Выполни порученную подзадачу и верни краткий отчёт.',
				].join('\n\n'),
			});
		} catch {
			continue;
		}
	}

	return out;
}

// Создать stub `.haratsan/agents/{name}.md` из описания (Agent.generate MVP) или builtin preset
export async function generateAgentStub(params: {
	name: string;
	description: string;
	mode?: string;
	readonly?: boolean;
}): Promise<{ 
	relativePath: string
	created: boolean
}> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error('Нет открытого workspace');
	}

	const preset = getBuiltinPreset(params.name);
	const id = slugifyAgentName(preset?.name ?? params.name);
	const dir = vscode.Uri.joinPath(folder.uri, '.haratsan', 'agents');
	try {
		await vscode.workspace.fs.stat(dir);
	} catch {
		await vscode.workspace.fs.createDirectory(dir);
	}

	const uri = vscode.Uri.joinPath(dir, `${id}.md`);
	let created = true;
	try {
		await vscode.workspace.fs.stat(uri);
		created = false;
	} catch {
		created = true;
	}

	const mode = (params.mode ?? preset?.mode ?? 'agent').trim() || 'agent';
	const readonly = params.readonly === true || preset?.readonly === true;
	const description = (params.description.trim() || preset?.description || params.name.trim()).trim();
	const displayName = (preset?.name ?? params.name).trim() || id;
	const bodySection = preset?.body?.trim()
		? preset.body.trim()
		: [
			`# ${displayName}`,
			'',
			description,
			'',
			'## Инструкции',
			'',
			'- Выполни порученную подзадачу автономно.',
			'- Верни краткий отчёт с путями и выводами.',
			readonly
				? '- Только чтение: не правь файлы и не запускай мутирующие команды.'
				: '- Можешь читать и править файлы в рамках задачи.',
			'',
		].join('\n');

	const markdown = [
		'---',
		`name: ${displayName}`,
		`description: ${description}`,
		`mode: ${mode}`,
		`readonly: ${readonly}`,
		'---',
		'',
		bodySection.startsWith('#') ? bodySection : `${bodySection}\n`,
	].join('\n');

	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(markdown.endsWith('\n') ? markdown : `${markdown}\n`));
	return {
		relativePath: vscode.workspace.asRelativePath(uri),
		created,
	};
}

// Клонировать builtin preset в `.haratsan/agents/{name}.md`
export async function cloneBuiltinPreset(id: string): Promise<{
	relativePath: string;
	created: boolean;
}> {
	const preset = getBuiltinPreset(id);
	if (!preset) {
		throw new Error(`Неизвестный builtin preset: ${id}`);
	}

	return generateAgentStub({
		name: preset.name,
		description: preset.description,
		mode: preset.mode,
		readonly: preset.readonly,
	});
}
