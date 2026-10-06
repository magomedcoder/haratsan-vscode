import * as vscode from 'vscode';
import { formatMiniDiff } from './diff';
import { AGENT_LIMITS } from './policy';
import type { PlanStepStatus, StickyPlan, StickyPlanSnapshot, StickyPlanStep } from './plan';

export const DEFAULT_PLAN_RELATIVE = '.haratsan/plan.md';

export class PlanFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlanFileError';
	}
}

const STATUS_MARK: Record<PlanStepStatus, string> = {
	pending: ' ',
	in_progress: '~',
	done: 'x',
	skipped: '-',
};

function markToStatus(mark: string): PlanStepStatus {
	const m = mark.trim().toLowerCase();
	if (m === 'x') {
		return 'done';
	}

	if (m === '~' || m === '>') {
		return 'in_progress';
	}

	if (m === '-' || m === '/') {
		return 'skipped';
	}

	return 'pending';
}

// Markdown плана, который можно править руками
export function serializePlanMarkdown(snap: StickyPlanSnapshot): string {
	const lines = [
		`# ${snap.title.trim() || 'План'}`,
		'',
		'<!-- План Haratsan: [ ] ожидает | [~] в работе | [x] готово | [-] пропуск -->',
		'<!-- Формат шага: - [ ] Заголовок | `path` | action -->',
		'',
	];

	for (const step of snap.steps) {
		const mark = STATUS_MARK[step.status] ?? ' ';
		const parts = [`- [${mark}] ${step.title.trim() || 'шаг'}`];
		if (step.path?.trim()) {
			parts.push(`\`${step.path.trim()}\``);
		}

		if (step.action?.trim()) {
			parts.push(step.action.trim());
		}

		lines.push(parts.join(' | '));
	}

	lines.push('');

	return lines.join('\n');
}

function parseStepBody(body: string): Omit<StickyPlanStep, 'status'> {
	const chunks = body.split('|').map((c) => c.trim()).filter(Boolean);
	let title = chunks[0] || 'шаг';
	let path: string | undefined;
	let action: string | undefined;

	for (let i = 1; i < chunks.length; i += 1) {
		const chunk = chunks[i];
		const tick = chunk.match(/^`([^`]+)`$/);
		if (tick) {
			path = tick[1].trim();
			continue;
		}

		const pathPref = chunk.match(/^path:\s*(.+)$/i);
		if (pathPref) {
			path = pathPref[1].replace(/^`|`$/g, '').trim();
			continue;
		}
		
		const actionPref = chunk.match(/^action:\s*(.+)$/i);
		if (actionPref) {
			action = actionPref[1].trim();
			continue;
		}

		if (!path && /[./\\]/.test(chunk)) {
			path = chunk.replace(/^`|`$/g, '').trim();
			continue;
		}

		if (!action) {
			action = chunk;
		}
	}

	// Заголовок может быть только путём в обратных кавычках
	const titleTick = title.match(/^`([^`]+)`$/);
	if (titleTick && !path) {
		path = titleTick[1].trim();
		title = path;
	}

	return {
		title: title || path || action || 'шаг',
		...(path ? { path } : {}),
		...(action ? { action } : {}),
	};
}

export function parsePlanMarkdown(text: string): StickyPlanSnapshot {
	const raw = text.replace(/^\uFEFF/, '');
	const lines = raw.split(/\r?\n/);
	let title = '';
	const steps: StickyPlanStep[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('<!--')) {
			continue;
		}

		const heading = trimmed.match(/^#\s+(.+)$/);
		if (heading && !title) {
			title = heading[1].trim();
			continue;
		}

		const check = trimmed.match(/^- \[([ xX~\-/])\]\s+(.+)$/);
		if (check) {
			const status = markToStatus(check[1]);
			const body = parseStepBody(check[2]);
			steps.push({ ...body, status });
			continue;
		}

		const numbered = trimmed.match(/^\d+\.\s+(?:\[(pending|in_progress|done|skipped)\]\s+)?(.+)$/i);
		if (numbered) {
			const status = (numbered[1]?.toLowerCase() as PlanStepStatus | undefined) ?? 'pending';
			const body = parseStepBody(numbered[2]);
			steps.push({
				...body,
				status:	status === 'pending' || status === 'in_progress' || status === 'done' || status === 'skipped' ? status : 'pending',
			});
		}
	}

	if (steps.length === 0) {
		throw new PlanFileError(vscode.l10n.t('plan.noStepsInFile'));
	}

	if (steps.length > AGENT_LIMITS.maxPlanSteps) {
		throw new PlanFileError(vscode.l10n.t('plan.tooManySteps', steps.length, AGENT_LIMITS.maxPlanSteps));
	}

	return {
		title: title || 'План',
		steps,
		approved: true,
	};
}

export interface PlanReloadResult {
	// Файла нет или он пустой - активного плана на диске нет
	empty: boolean;
	parseError?: string;
	// Разность: предыдущий канонический текст -> текущий файл (правки пользователя)
	userDiff?: string;
	relativePath: string;
}

/**
 * Применить текст с диска к StickyPlan и посчитать diff правок относительно последнего канонического markdown.
 * Возвращает новый канонический текст после принятия файла как источника истины.
 */
export function applyPlanFileText(plan: StickyPlan, fileText: string | undefined, lastCanonical: string, relativePath = DEFAULT_PLAN_RELATIVE): PlanReloadResult & { nextCanonical: string } {
	if (fileText === undefined || !fileText.trim()) {
		plan.clear();
		return {
			empty: true,
			relativePath,
			nextCanonical: '',
		};
	}

	let snap: StickyPlanSnapshot;
	try {
		snap = parsePlanMarkdown(fileText);
	} catch (err) {
		return {
			empty: false,
			parseError: err instanceof Error ? err.message : String(err),
			relativePath,
			nextCanonical: lastCanonical,
		};
	}

	const normalized = serializePlanMarkdown(snap);
	const userDiff =lastCanonical && lastCanonical !== fileText && lastCanonical !== normalized
		? formatMiniDiff(lastCanonical, fileText)
		: lastCanonical && lastCanonical !== normalized
			? formatMiniDiff(lastCanonical, normalized)
			: undefined;

	plan.restore(snap);
	return {
		empty: false,
		userDiff: userDiff || undefined,
		relativePath,
		nextCanonical: normalized,
	};
}
