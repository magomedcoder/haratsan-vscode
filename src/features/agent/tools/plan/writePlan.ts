import { formatPlan, parsePlanArgs } from '../../plan';
import type { PlanStepStatus, StickyPlanSnapshot } from '../../plan';
import { listNamedPlans, normalizePlanSlug, writeNamedPlan } from '../../plansStore';
import { asString, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';

function asStepStatus(raw: unknown): PlanStepStatus {
	const v = String(raw ?? '').trim().toLowerCase();
	if (v === 'in_progress' || v === 'done' || v === 'skipped') {
		return v;
	}

	return 'pending';
}

function toSnapshot(args: Record<string, unknown>): StickyPlanSnapshot {
	const plan = parsePlanArgs(args);
	const rawSteps = Array.isArray(args.steps) ? args.steps : [];
	return {
		title: plan.title,
		approved: true,
		steps: plan.steps.map((step, i) => {
			const raw = rawSteps[i];
			const status = raw && typeof raw === 'object' && !Array.isArray(raw)
				? asStepStatus((raw as Record<string, unknown>).status)
				: 'pending';
			return { ...step, status };
		}),
	};
}

export const writePlanTool: ToolDefinition = {
	name: 'write_plan',
	description: 'Записать план в `.haratsan/plans/<slug>.md` (multi-plan). Sticky `.haratsan/plan.md` не меняется - для сессии по-прежнему propose_plan.',
	parameters: {
		type: 'object',
		properties: {
			slug: {
				type: 'string',
				description: 'Идентификатор плана (латиница, цифры, _-)',
			},
			title: {
				type: 'string',
				description: 'Заголовок плана',
			},
			steps: {
				type: 'array',
				description: 'Шаги плана',
				items: {
					type: 'object',
					properties: {
						title: { 
							type: 'string' 
						},
						path: { 
							type: 'string' 
						},
						action: { 
							type: 'string' 
						},
						status: {
							type: 'string',
							description: 'pending | in_progress | done | skipped',
						},
					},
					required: ['title'],
				},
			},
		},
		required: ['slug', 'title', 'steps'],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const slugRaw = asString(args, 'slug');
		const slug = normalizePlanSlug(slugRaw);
		if (!slug) {
			return {
				ok: false,
				content: `Некорректный slug: «${slugRaw}»`,
			};
		}

		try {
			const snap = toSnapshot(args);
			const { relativePath } = await writeNamedPlan(slug, snap);
			return {
				ok: true,
				path: relativePath,
				content: `План записан в ${relativePath}\n\n${formatPlan(parsePlanArgs(args))}`,
			};
		} catch (err) {
			return {
				ok: false,
				content: err instanceof Error ? err.message : String(err),
			};
		}
	},
};

export const listPlansTool: ToolDefinition = {
	name: 'list_plans',
	description: 'Список планов в `.haratsan/plans/*.md` (multi-plan артефакты). Sticky план - `.haratsan/plan.md`.',
	parameters: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
	async execute(_args, ctx): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const plans = await listNamedPlans();
		if (plans.length === 0) {
			return {
				ok: true,
				content: 'В `.haratsan/plans/` пока нет файлов. Sticky план: `.haratsan/plan.md`.',
			};
		}

		return {
			ok: true,
			content: plans.map((p) => `- ${p.slug} (${p.relativePath})`).join('\n'),
		};
	},
};
