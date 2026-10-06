import { discoverCustomAgents, resolveBuiltinPresetSubagent, BUILTIN_PRESETS } from '../project/customAgents';

export type SubagentType = string;

export interface SubagentDef {
	id: SubagentType;
	name: string;
	description: string;
	prompt: string;
	readonly: boolean;
	maxIterations: number;
}

export const BUILTIN_SUBAGENTS: SubagentDef[] = [
	{
		id: 'explore',
		name: 'Explore',
		description: 'Быстрый read-only обзор кодовой базы (grep/glob/read/search).',
		readonly: true,
		maxIterations: 12,
		prompt: [
			'Ты субагент Explore. Только исследование (read-only).',
			'План: 1) сформулируй 2-4 гипотезы/точки входа; 2) multi-hop поиск (сначала find_code / project_map / find_symbol, затем точечный read_file); 3) при необходимости glob/grep/codebase_search/pack_context.',
			'Не правь файлы и не запускай мутирующие команды.',
			'Верни сжатый отчёт: только важное - пути, ключевые символы/фрагменты, выводы и пробелы (что не нашёл).',
		].join(' '),
	},
	{
		id: 'general',
		name: 'General',
		description: 'Многошаговая подзадача с полными tools (кроме вложенного task).',
		readonly: false,
		maxIterations: 20,
		prompt: [
			'Ты субагент General. Выполни порученную подзадачу автономно.',
			'Можешь читать и править файлы в рамках задачи.',
			'Не вызывай tool task повторно. В конце дай сжатый summary результата.',
		].join(' '),
	},
	{
		id: 'scout',
		name: 'Scout',
		description: 'Read-only разведка внешней документации: web_search, fetch_page, search_docs.',
		readonly: true,
		maxIterations: 14,
		prompt: [
			'Ты субагент Scout. Фокус - внешняя документация и веб.',
			'План multi-hop: web_search -> fetch_page / search_docs -> сверка с локальным кодом через find_code / project_map / find_symbol при необходимости.',
			'Не правь файлы и не запускай мутирующие команды.',
			'При use_worktree: работай только в выданном cwd; после успеха parent обычно удаляет worktree (cleanup_worktree).',
			'Верни сжатый отчёт: URL, ключевые цитаты, выводы; без воды.',
		].join(' '),
	},
];

export function getBuiltinSubagent(id: string): SubagentDef | undefined {
	return BUILTIN_SUBAGENTS.find((s) => s.id === id || s.name.toLowerCase() === id.toLowerCase());
}

// Builtin + кастомные `.haratsan/agents/*.md` + встроенные presets
export async function resolveSubagent(id: string): Promise<SubagentDef | undefined> {
	const builtin = getBuiltinSubagent(id);
	if (builtin) {
		return builtin;
	}

	const customs = await discoverCustomAgents();
	const needle = id.trim().toLowerCase();
	const custom = customs.find((s) => s.id === needle || s.name.toLowerCase() === needle);
	if (custom) {
		return custom;
	}

	return resolveBuiltinPresetSubagent(id);
}

export async function listSubagentIds(): Promise<string[]> {
	const customs = await discoverCustomAgents();
	return [
		...BUILTIN_SUBAGENTS.map((s) => s.id),
		...BUILTIN_PRESETS.map((p) => p.id),
		...customs.map((s) => s.id),
	];
}
