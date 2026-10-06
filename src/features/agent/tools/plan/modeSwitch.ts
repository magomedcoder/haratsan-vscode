import type { ChatMode } from '../../../../core/config/types';
import { asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';

export type SetChatModeFn = (mode: ChatMode) => void | Promise<void>;

export interface ModeSwitchContext extends ToolContext {
	setChatMode?: SetChatModeFn;
}

const VALID_MODES: readonly ChatMode[] = ['ask', 'agent', 'debug', 'design', 'plan', 'multitask', 'project'];

// Напоминание модели при входе в Plan (tool / slash / UI)
export const PLAN_ENTER_REMINDER = [
	'Режим Plan включён.',
	'Используй только чтение/поиск (read_file, glob, grep, codebase_search и т.п.) и propose_plan / write_plan.',
	'Правки файлов (write_file, apply_patch, delete_file) запрещены.',
	'Shell (run_command / run_tests): только с подтверждением пользователя, если planShellPolicy=ask; иначе недоступен - перейди в Agent (/agent или plan_exit).',
	'Когда план готов - propose_plan; после подтверждения пользователя перейди в agent через plan_exit или /agent.',
].join(' ');

// Напоминание модели при выходе Plan * Agent
export const PLAN_EXIT_REMINDER = 'Режим Agent включён. Можно править файлы и запускать команды в рамках политики подтверждений. Следуй активному плану в `.haratsan/plan.md`, если он есть.';

function asChatMode(raw: string): ChatMode | undefined {
	const v = raw.trim().toLowerCase() as ChatMode;
	return VALID_MODES.includes(v) ? v : undefined;
}

async function applyMode(ctx: ToolContext, mode: ChatMode): Promise<string | undefined> {
	const ext = ctx as ModeSwitchContext;
	if (!ext.setChatMode) {
		return 'Смена режима недоступна в этом контексте (нет setChatMode).';
	}

	await ext.setChatMode(mode);
	return undefined;
}

export const planEnterTool: ToolDefinition = {
	name: 'plan_enter',
	description: 'Переключить чат в режим Plan (только анализ и план, без мутаций). Вернёт напоминание для модели.',
	parameters: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	async execute(_args, ctx): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const err = await applyMode(ctx, 'plan');
		if (err) {
			return {
				ok: false,
				content: err,
			};
		}

		// Полное напоминание добавляет ChatSession.setMode
		return {
			ok: true,
			content: 'Режим Plan включён.',
		};
	},
};

export const planExitTool: ToolDefinition = {
	name: 'plan_exit',
	description: 'Выйти из Plan в режим Agent (полные tools).',
	parameters: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	async execute(_args, ctx): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const err = await applyMode(ctx, 'agent');
		if (err) {
			return {
				ok: false,
				content: err,
			};
		}

		// Полное напоминание добавляет ChatSession.setMode
		return {
			ok: true,
			content: 'Режим Agent включён.',
		};
	},
};

export const switchModeTool: ToolDefinition = {
	name: 'switch_mode',
	description: 'Переключить режим чата: ask | agent | debug | design | plan | multitask | project.',
	parameters: {
		type: 'object',
		properties: {
			mode: {
				type: 'string',
				description: 'ask | agent | debug | design | plan | multitask | project',
			},
		},
		required: ['mode'],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const mode = asChatMode(asString(args, 'mode'));
		if (!mode) {
			return {
				ok: false,
				content: `Неизвестный mode. Допустимо: ${VALID_MODES.join(', ')}`,
			};
		}

		const err = await applyMode(ctx, mode);
		if (err) {
			return {
				ok: false,
				content: err,
			};
		}

		if (mode === 'plan') {
			// Полное напоминание - ChatSession.setMode
			return {
				ok: true,
				content: 'Режим Plan включён.',
			};
		}

		if (mode === 'agent') {
			return {
				ok: true,
				content: 'Режим Agent включён.',
			};
		}

		if (mode === 'multitask') {
			return {
				ok: true,
				content: [
					'Режим Multitask (координатор) включён.',
					'Не правь файлы напрямую - делегируй подзадачи через tool task.',
					'Сам используй только чтение/поиск и оркестрацию.',
				].join(' '),
			};
		}

		if (mode === 'project') {
			return {
				ok: true,
				content: [
					'Режим Project (тимлид) включён.',
					'Не правь файлы напрямую - делегируй подзадачи через tool task.',
					'Координируй команду и собирай отчёты субагентов.',
				].join(' '),
			};
		}

		return {
			ok: true,
			content: `Режим переключён на «${mode}».`,
		};
	},
};
