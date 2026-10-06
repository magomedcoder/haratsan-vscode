import * as vscode from 'vscode';
import { AGENT_LIMITS } from './policy';
import { asObjectArray, asString, type ToolResult } from './types';

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface PlanStep {
	title: string;
	path?: string;
	action?: string;
}

export interface AgentPlan {
	title: string;
	steps: PlanStep[];
}

export interface StickyPlanStep extends PlanStep {
	status: PlanStepStatus;
}

export interface StickyPlanSnapshot {
	title: string;
	steps: StickyPlanStep[];
	approved: boolean;
}

export interface StickyPlanUi {
	title: string;
	steps: Array<{
		title: string;
		path?: string;
		action?: string;
		status: PlanStepStatus;
	}>;
}

const MULTI_FILE_PLAN_HINT = 'Правки в нескольких файлах требуют плана. Вызовите propose_plan (заголовок и шаги с путями) и дождитесь подтверждения.';
const OUTSIDE_PLAN_HINT = 'Путь вне активного плана сессии. Вызови update_plan (добавь шаг) или propose_plan заново, либо попроси пользователя отменить план.';

export function normalizePlanPath(path: string): string {
	return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export function parsePlanArgs(args: Record<string, unknown>): AgentPlan {
	const title = asString(args, 'title').trim() || vscode.l10n.t('plan.defaultTitle');
	const steps = asObjectArray(args, 'steps').map((item) => {
		const stepTitle = asString(item, 'title').trim() || asString(item, 'summary').trim();
		const path = asString(item, 'path').trim();
		const action = asString(item, 'action').trim();
		return {
			title: stepTitle || path || action || vscode.l10n.t('plan.defaultStep'),
			...(path ? { path } : {}),
			...(action ? { action } : {}),
		};
	});

	if (steps.length === 0) {
		throw new Error(vscode.l10n.t('plan.needSteps'));
	}

	if (steps.length > AGENT_LIMITS.maxPlanSteps) {
		throw new Error(vscode.l10n.t('plan.tooManySteps', steps.length, AGENT_LIMITS.maxPlanSteps));
	}

	return { title, steps };
}

export function formatPlan(plan: AgentPlan): string {
	const lines = [plan.title];
	plan.steps.forEach((step, i) => {
		const bits = [step.title];
		if (step.path) {
			bits.push(step.path);
		}

		if (step.action) {
			bits.push(step.action);
		}

		lines.push(`${i + 1}. ${[...new Set(bits)].join(' - ')}`);
	});

	return lines.join('\n');
}

export function formatStickyPlanForPrompt(plan: StickyPlanSnapshot): string {
	const lines = [
		`Активный план сессии (следуй ему, пока пользователь не отменит или не попросит перепланировать): «${plan.title}».`,
		'Не бросай задачу mid-flight ради побочных правок. Отмечай прогресс через update_plan.',
	];
	plan.steps.forEach((step, i) => {
		const bits = [`[${step.status}]`, step.title];
		if (step.path) {
			bits.push(step.path);
		}

		if (step.action) {
			bits.push(step.action);
		}

		lines.push(`${i + 1}. ${bits.join(' ')}`);
	});
	const pending = plan.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress').length;
	if (pending > 0) {
		lines.push(`Осталось шагов: ${pending}. Не считай задачу закрытой, пока есть pending/in_progress.`);
	} else {
		lines.push('Все шаги done/skipped. Можно кратко подвести итог или очистить план через update_plan clear.');
	}

	return lines.join('\n');
}

export function mutationPathsFromArgs(name: string, args: Record<string, unknown>): string[] {
	if (name === 'apply_workspace_edit') {
		return [...new Set(asObjectArray(args, 'edits').map((item) => asString(item, 'path').trim()).filter(Boolean))];
	}

	const path = asString(args, 'path').trim();
	return path ? [path] : [];
}

function toStickySteps(plan: AgentPlan): StickyPlanStep[] {
	return plan.steps.map((step) => ({
		...step,
		status: 'pending' as const,
	}));
}

// План сессии: in-memory кэш; при старте и перед ходом агента подгружается из `.haratsan/plan.md`
export class StickyPlan {
	private title = '';
	private steps: StickyPlanStep[] = [];
	private approved = false;
	// Пути, разрешённые без повторного propose_plan (из шагов и уже затронутые под этим планом)
	private readonly allowed = new Set<string>();
	// До подтверждения: учёт одного файла, пока не вызвали propose_plan
	private readonly pendingFiles = new Set<string>();

	get isApproved(): boolean {
		return this.approved;
	}

	get hasPlan(): boolean {
		return this.steps.length > 0;
	}

	snapshot(): StickyPlanSnapshot | undefined {
		if (!this.hasPlan) {
			return undefined;
		}

		return {
			title: this.title,
			steps: this.steps.map((s) => ({ ...s })),
			approved: this.approved,
		};
	}

	toUi(): StickyPlanUi | undefined {
		const snap = this.snapshot();
		if (!snap || !snap.approved) {
			return undefined;
		}

		return {
			title: snap.title,
			steps: snap.steps.map((s) => ({
				title: s.title,
				path: s.path,
				action: s.action,
				status: s.status,
			})),
		};
	}

	restore(data: StickyPlanSnapshot | undefined): void {
		this.clear();
		if (!data?.steps?.length) {
			return;
		}

		this.title = data.title || vscode.l10n.t('plan.defaultName');
		this.steps = data.steps.map((s) => ({
			title: s.title,
			...(s.path ? { path: s.path } : {}),
			...(s.action ? { action: s.action } : {}),
			status: s.status ?? 'pending',
		}));
		this.approved = Boolean(data.approved);
		this.rebuildAllowedFromSteps();
	}

	approve(plan: AgentPlan): void {
		this.title = plan.title;
		this.steps = toStickySteps(plan);
		this.approved = true;
		this.pendingFiles.clear();
		this.rebuildAllowedFromSteps();
	}

	clear(): void {
		this.title = '';
		this.steps = [];
		this.approved = false;
		this.allowed.clear();
		this.pendingFiles.clear();
	}

	setStepStatus(index1Based: number, status: PlanStepStatus): void {
		const idx = index1Based - 1;
		if (idx < 0 || idx >= this.steps.length) {
			throw new Error(vscode.l10n.t('plan.noStep', index1Based, this.steps.length));
		}

		this.steps[idx] = { 
			...this.steps[idx], 
			status 
		};
	}

	replaceSteps(plan: AgentPlan, keepProgress = false): void {
		const prevByPath = new Map<string, PlanStepStatus>();
		if (keepProgress) {
			for (const step of this.steps) {
				if (step.path) {
					prevByPath.set(normalizePlanPath(step.path), step.status);
				}
			}
		}

		this.title = plan.title;
		this.steps = toStickySteps(plan).map((step) => {
			if (!keepProgress || !step.path) {
				return step;
			}

			const prev = prevByPath.get(normalizePlanPath(step.path));
			return prev ? { 
				...step, 
				status: prev 
			} : step;
		});
		this.approved = true;
		this.pendingFiles.clear();
		this.rebuildAllowedFromSteps();
	}

	markDoneByPaths(paths: string[]): void {
		if (!this.approved || paths.length === 0) {
			return;
		}

		const wanted = new Set(paths.map(normalizePlanPath));
		this.steps = this.steps.map((step) => {
			if (!step.path) {
				return step;
			}

			if (!wanted.has(normalizePlanPath(step.path))) {
				return step;
			}

			if (step.status === 'done' || step.status === 'skipped') {
				return step;
			}
			
			return { 
				...step, 
				status: 'done' 
			};
		});
	}

	guard(paths: string[]): ToolResult | undefined {
		const incoming = [...new Set(paths.map((p) => normalizePlanPath(p)).filter(Boolean))];
		if (incoming.length === 0) {
			return undefined;
		}

		if (this.approved) {
			// План без path в шагах - после подтверждения можно править любые файлы
			if (this.allowed.size === 0) {
				return undefined;
			}

			for (const path of incoming) {
				if (!this.allowed.has(path)) {
					return {
						ok: false,
						denied: true,
						content: `${OUTSIDE_PLAN_HINT}\n${vscode.l10n.t('plan.outsidePath', path)}`,
					};
				}
			}
			return undefined;
		}

		const next = new Set(this.pendingFiles);
		for (const path of incoming) {
			next.add(path);
		}

		if (incoming.length > 1 || next.size > 1) {
			return {
				ok: false,
				denied: true,
				content: MULTI_FILE_PLAN_HINT,
			};
		}

		for (const path of incoming) {
			this.pendingFiles.add(path);
		}

		return undefined;
	}

	private rebuildAllowedFromSteps(): void {
		this.allowed.clear();
		for (const step of this.steps) {
			if (step.path) {
				this.allowed.add(normalizePlanPath(step.path));
			}
		}
	}
}
