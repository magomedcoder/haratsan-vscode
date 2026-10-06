import { generateAgentStub } from '../../../project/customAgents';
import { asString, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';
import { confirmAlwaysOrSkip } from '../confirm';

export const generateAgentTool: ToolDefinition = {
	name: 'generate_agent',
	description: 'Создать stub кастомного агента в `.haratsan/agents/{name}.md` по описанию. Builtin presets: docs-researcher, code-reviewer - можно материализовать по имени. Затем доступен через tool task.',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Имя агента или preset (docs-researcher | code-reviewer)',
			},
			description: {
				type: 'string',
				description: 'Краткое описание роли (для preset можно кратко повторить)',
			},
			mode: {
				type: 'string',
				description: 'Подсказка режима: agent | ask | plan | ...',
			},
			readonly: {
				type: 'boolean',
				description: 'Только чтение (как explore)',
			},
		},
		required: ['name', 'description'],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const name = asString(args, 'name').trim();
		const description = asString(args, 'description').trim();
		if (!name || !description) {
			return { 
				ok: false,
				content: 'Нужны name и description'
			};
		}

		const denied = await confirmAlwaysOrSkip(ctx, `Создать агента «${name}»`, description.slice(0, 400));
		if (denied) {
			return denied;
		}

		try {
			const { relativePath, created } = await generateAgentStub({
				name,
				description,
				mode: asString(args, 'mode') || undefined,
				readonly: args.readonly === true,
			});
			return {
				ok: true,
				path: relativePath,
				content: created
					? `Создан агент: ${relativePath}. Запуск: task с subagent_type = имя агента.`
					: `Обновлён агент: ${relativePath}. Запуск: task с subagent_type = имя агента.`,
			};
		} catch (err) {
			return {
				ok: false,
				content: err instanceof Error ? err.message : String(err),
			};
		}
	},
};
