import type { ChatMode } from '../../core/config/types';

export interface SlashCommand {
	id: string;
	// Имя команды без ведущего `/`, например `debug`
	name: string;
	// Ключ i18n для подписи в автодополнении (builtin)
	detailKey?: string;
	// Готовая подпись (кастомные команды из `.haratsan/commands`)
	detail?: string;
	// Если задан - переключает режим чата
	mode?: ChatMode;
	// Кастомная команда ждёт аргументы ($ARGUMENTS / $1...)
	needsArgs?: boolean;
	// Подсказка для picker: «укажи путь...»
	argsHint?: string;
	// Сколько позиционных $n минимум
	minPositionalArgs?: number;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		id: 'debug',
		name: 'debug',
		detailKey: 'chat.slash.debug',
		mode: 'debug',
	},
	{
		id: 'design',
		name: 'design',
		detailKey: 'chat.slash.design',
		mode: 'design',
	},
	{
		id: 'plan',
		name: 'plan',
		detailKey: 'chat.slash.plan',
		mode: 'plan',
	},
	{
		id: 'multitask',
		name: 'multitask',
		detailKey: 'chat.slash.multitask',
		mode: 'multitask',
	},
	{
		id: 'project',
		name: 'project',
		detailKey: 'chat.slash.project',
		mode: 'project',
	},
	{
		id: 'ask',
		name: 'ask',
		detailKey: 'chat.slash.ask',
		mode: 'ask',
	},
	{
		id: 'agent',
		name: 'agent',
		detailKey: 'chat.slash.agent',
		mode: 'agent',
	},
	{
		id: 'export',
		name: 'export',
		detailKey: 'chat.slash.export',
	},
	{
		id: 'import',
		name: 'import',
		detailKey: 'chat.slash.import',
	},
	{
		id: 'init',
		name: 'init',
		detailKey: 'chat.slash.init',
	},
	{
		id: 'new',
		name: 'new',
		detailKey: 'chat.slash.new',
	},
	{
		id: 'compact',
		name: 'compact',
		detailKey: 'chat.slash.compact',
	},
	{
		id: 'restore-archive',
		name: 'restore-archive',
		detailKey: 'chat.slash.restoreArchive',
	},
	{
		id: 'undo',
		name: 'undo',
		detailKey: 'chat.slash.undo',
	},
	{
		id: 'deep-planning',
		name: 'deep-planning',
		detailKey: 'chat.slash.deepPlanning',
	},
	{
		id: 'compare',
		name: 'compare',
		detailKey: 'chat.slash.compare',
	},
	{
		id: 'redo',
		name: 'redo',
		detailKey: 'chat.slash.redo',
	},
	{
		id: 'sessions',
		name: 'sessions',
		detailKey: 'chat.slash.sessions',
	},
	{
		id: 'models',
		name: 'models',
		detailKey: 'chat.slash.models',
	},
] as const;

export interface ParsedSlashMode {
	mode?: ChatMode;
	command: string;
	// Текст после команды; пусто, если только команда
	rest: string;
	custom?: boolean;
}

const SLASH_NAME_RE = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/;

// Разобрать ведущую slash-команду (builtin + опционально кастомные)
export function parseSlashMode(
	text: string,
	extra: readonly SlashCommand[] = [],
): ParsedSlashMode | undefined {
	const trimmed = text.trim();
	const match = SLASH_NAME_RE.exec(trimmed);
	if (!match) {
		return undefined;
	}

	const name = match[1]!.toLowerCase();
	const builtin = SLASH_COMMANDS.find((c) => c.name === name);
	const custom = !builtin ? extra.find((c) => c.name === name) : undefined;
	const cmd = builtin ?? custom;
	if (!cmd) {
		return undefined;
	}

	return {
		mode: cmd.mode,
		command: cmd.name,
		rest: (match[2] ?? '').trim(),
		custom: Boolean(custom),
	};
}

// Активный токен `/...` в начале ввода (для автодополнения)
export function activeSlashQuery(text: string, cursor: number): {
	start: number;
	query: string;
} | undefined {
	const before = text.slice(0, cursor);
	if (!before.startsWith('/') || before.includes('\n') || before.includes(' ')) {
		return undefined;
	}

	return {
		start: 0,
		query: before.slice(1).toLowerCase(),
	};
}

export function filterSlashCommands(
	query: string,
	extra: readonly SlashCommand[] = [],
): SlashCommand[] {
	const q = query.trim().toLowerCase();
	const seen = new Set<string>();
	const all: SlashCommand[] = [];
	for (const cmd of [...SLASH_COMMANDS, ...extra]) {
		const key = cmd.name.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		all.push(cmd);
	}

	if (!q) {
		return all;
	}

	return all.filter((c) => c.name.startsWith(q));
}
