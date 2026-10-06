import * as vscode from 'vscode';
import { discoverSkills } from '../../../project/skills';
import type { TodoItem, TodoStore } from '../../todoStore';
import { asString, type ConfirmChoice, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';

export interface ExtendedToolContext extends ToolContext {
	todos?: TodoStore;
	askQuestion?(request: {
		title: string;
		questions: Array<{
			id: string;
			prompt: string; 
			options?: string[] 
		}>;
	}): Promise<Record<string, string>>;
}

function asTodos(args: Record<string, unknown>): TodoItem[] {
	const raw = args.todos;
	if (!Array.isArray(raw)) {
		return [];
	}

	return raw.map((item, i) => {
		const obj = item && typeof item === 'object' ? item as Record<string, unknown> : {};
		const status = String(obj.status ?? 'pending');
		return {
			id: String(obj.id ?? `t${i + 1}`),
			content: String(obj.content ?? ''),
			status: (status === 'in_progress' || status === 'completed' || status === 'cancelled' ? status : 'pending') as TodoItem['status'],
		};
	});
}

export const todoWriteTool: ToolDefinition = {
	name: 'todo_write',
	description: 'Создать/обновить список задач текущего agent run.',
	parameters: {
		type: 'object',
		properties: {
			todos: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id: {
							type: 'string'
						},
						content: {
							type: 'string'
						},
						status: {
							type: 'string',
							enum: ['pending', 'in_progress', 'completed', 'cancelled']
						},
					},
					required: ['content'],
				},
			},
		},
		required: ['todos'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const store = (ctx as ExtendedToolContext).todos;
		if (!store) {
			return {
				ok: false,
				content: 'Хранилище todos недоступно'
			};
		}

		const items = store.write(asTodos(args));
		return {
			ok: true,
			content: JSON.stringify({ todos: items }, null, 2)
		};
	},
};

export const todoReadTool: ToolDefinition = {
	name: 'todo_read',
	description: 'Прочитать текущий список задач agent run.',
	parameters: { type: 'object', properties: {}, additionalProperties: false },
	async execute(_args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const store = (ctx as ExtendedToolContext).todos;
		if (!store) {
			return {
				ok: false,
				content: 'Хранилище todos недоступно'
			};
		}

		return {
			ok: true,
			content: JSON.stringify({ todos: store.read() }, null, 2)
		};
	},
};

export const askQuestionTool: ToolDefinition = {
	name: 'ask_question',
	description: 'Задать пользователю структурированный вопрос (choices или свободный ответ) mid-run.',
	parameters: {
		type: 'object',
		properties: {
			title: {
				type: 'string'
			},
			prompt: {
				type: 'string'

			},
			options: {
				type: 'array',
				items: {
					type: 'string'
				}
			},
		},
		required: ['prompt'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const prompt = asString(args, 'prompt');
		const title = asString(args, 'title', 'Вопрос');
		const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : [];
		const ask = (ctx as ExtendedToolContext).askQuestion;
		if (ask) {
			const answers = await ask({
				title,
				questions: [{
					id: 'q0',
					prompt, options
				}],
			});
			return {
				ok: true,
				content: JSON.stringify({ answers }, null, 2)
			};
		}

		if (!ctx.confirm) {
			return {
				ok: false,
				content: 'UI подтверждения недоступен'
			};
		}

		const detail = options.length ? `Варианты: ${options.join(' | ')}\n\n${prompt}` : prompt;
		const choice: ConfirmChoice = await ctx.confirm({ title, detail });
		if (choice === 'abort') {
			const err = new Error(vscode.l10n.t('agent.operationCancelled'));
			err.name = 'AbortError';
			throw err;
		}

		return {
			ok: true,
			content: JSON.stringify({
				answer: choice === 'apply' ? (options[0] ?? 'да') : 'пропущено',
				choice,
			}, null, 2),
		};
	},
};

export const skillTool: ToolDefinition = {
	name: 'skill',
	description: 'Загрузить SKILL.md по имени в контекст (из .haratsan/skills, .agents/skills).',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Имя skill'
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
				content: 'skill: нужен параметр name'
			};
		}

		const skills = await discoverSkills();
		const hit = skills.find((s) => s.name.toLowerCase() === name);
		if (!hit) {
			return {
				ok: false,
				content: `Неизвестный skill "${name}". Доступны: ${skills.map((s) => s.name).join(', ') || '(нет)'}`,
			};
		}
		
		return {
			ok: true,
			content: `# Skill: ${hit.name}\nПуть: ${hit.path}\n\n${hit.body}`,
		};
	},
};
