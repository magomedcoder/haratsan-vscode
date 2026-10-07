import { DEFAULT_APPROVAL_POLICY } from '../../core/config/approvalTypes';
import type { ApprovalActionType, ApprovalPolicy, ApprovalRule } from '../../core/config/approvalTypes';
import { isDeniedRelativePath } from './policy';
import { getToolMeta } from './tools/registry';
export type { ApprovalActionType, ApprovalMode, ApprovalPolicy, ApprovalRule } from '../../core/config/approvalTypes';
export { DEFAULT_APPROVAL_POLICY } from '../../core/config/approvalTypes';

const DELETE_TOOLS = new Set(['delete_file']);
const TASK_TOOLS = new Set(['task']);
const SKILL_TOOLS = new Set(['skill']);
// Fallback, пока meta ещё не зарегистрирована (тесты / ранний вызов)
const WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'apply_workspace_edit', 'edit_file', 'create_dir', 'edit_notebook']);
const SHELL_TOOLS = new Set(['run_command', 'run_tests', 'await_shell', 'run_scratch']);
const WEB_TOOLS = new Set(['fetch_page', 'web_search', 'open_browser']);

export function toolActionType(toolName: string): ApprovalActionType | undefined {
	if (DELETE_TOOLS.has(toolName)) {
		return 'delete';
	}

	if (TASK_TOOLS.has(toolName)) {
		return 'task';
	}

	if (SKILL_TOOLS.has(toolName)) {
		return 'skill';
	}

	const risk = getToolMeta(toolName)?.risk;
	if (risk === 'write') {
		return 'edits';
	}

	if (risk === 'shell') {
		return 'shell';
	}

	if (risk === 'web') {
		return 'web';
	}

	if (risk === 'read') {
		return undefined;
	}

	// Fallback по имени (без registry meta)
	if (WRITE_TOOLS.has(toolName)) {
		return 'edits';
	}

	if (SHELL_TOOLS.has(toolName)) {
		return 'shell';
	}

	if (WEB_TOOLS.has(toolName)) {
		return 'web';
	}

	return undefined;
}

function matchPattern(pattern: string, subject: string): boolean {
	const p = pattern.trim();
	const s = subject.trim();
	if (!p) {
		return false;
	}

	if (p === '*' || p === s) {
		return true;
	}

	if (p.endsWith('/**')) {
		const prefix = p.slice(0, -3);
		return s === prefix || s.startsWith(`${prefix}/`);
	}

	if (p.endsWith('*')) {
		return s.startsWith(p.slice(0, -1));
	}

	if (p.startsWith('*')) {
		return s.endsWith(p.slice(1));
	}

	return s.includes(p);
}

function listHit(list: string[], subject: string): boolean {
	return list.some((item) => matchPattern(item, subject));
}

export function isRiskySubject(action: ApprovalActionType, subject: string): boolean {
	const s = subject.toLowerCase();
	if (action === 'shell') {
		return /\b(rm\s+-rf|sudo|chmod\s+777|mkfs|dd\s+if=|curl\s+[^\n]*\|\s*(ba)?sh)\b/.test(s) || (/\b(force|--force)\b/.test(s) && /\bgit\b/.test(s));
	}

	if (action === 'edits' || action === 'delete' || action === 'outside') {
		return /(^|\/)\.env(\.|$)|credentials|secrets|\.pem$|\.key$|id_rsa|id_ed25519/.test(s);
	}

	return false;
}

// Совпадение пути с sensitivePathPatterns (например `.env`, `.env.*`)
export function matchesSensitivePath(subject: string, patterns: readonly string[]): boolean {
	const s = subject.trim().replace(/\\/g, '/');
	if (!s || patterns.length === 0) {
		return false;
	}

	return isDeniedRelativePath(s, patterns);
}

export function suggestPattern(action: ApprovalActionType, toolName: string, subject: string): string | undefined {
	const s = subject.trim();
	if (!s) {
		return undefined;
	}

	if (action === 'shell') {
		const bin = s.split(/\s+/)[0]?.replace(/^.*\//, '');
		return bin ? `${bin}*` : undefined;
	}

	if (action === 'edits' || action === 'delete') {
		const slash = s.lastIndexOf('/');
		if (slash > 0) {
			return `${s.slice(0, slash)}/**`;
		}

		return s;
	}

	if (action === 'web') {
		try {
			const u = new URL(s.includes('://') ? s : `https://${s}`);
			return `${u.origin}/*`;
		} catch {
			return undefined;
		}
	}

	// task / skill / outside: sessionAllow сверяет `${action}:${subject}` и `subject`
	if (action === 'task' || action === 'skill' || action === 'outside') {
		const slash = s.indexOf('/');
		if (slash > 0) {
			// Префикс до первого `/`
			return `${action}:${s.slice(0, slash)}*`;
		}

		return `${action}:${s}`;
	}

	return `${toolName}:${s}`;
}

export type PermissionDecision = 'allow' | 'ask' | 'deny' | 'review';

export function evaluateApproval(
	action: ApprovalActionType,
	subject: string,
	policy: ApprovalPolicy,
	sessionAllow?: string[],
): PermissionDecision {
	const ruleCfg = policy[action] ?? DEFAULT_APPROVAL_POLICY[action];
	const key = `${action}:${subject}`;

	// Denylist сильнее Always/sessionAllow (явный запрет не обходится кнопкой Always)
	if (listHit(ruleCfg.denylist, subject)) {
		return 'deny';
	}

	if (sessionAllow?.some((item) => matchPattern(item, key) || matchPattern(item, subject))) {
		return 'allow';
	}

	if (listHit(ruleCfg.allowlist, subject)) {
		return 'allow';
	}

	if (ruleCfg.mode === 'allow') {
		return 'allow';
	}

	if (ruleCfg.mode === 'deny') {
		return 'deny';
	}

	if (ruleCfg.mode === 'review') {
		// Edits: явный diff preview до Apply (не heuristic allow).
		// Остальные action: прежняя heuristic (risky -> ask, иначе allow).
		if (action === 'edits') {
			return 'review';
		}

		return isRiskySubject(action, subject) ? 'ask' : 'allow';
	}

	return 'ask';
}

export function normalizeApprovalPolicy(raw: unknown): ApprovalPolicy {
	const base: ApprovalPolicy = structuredClone(DEFAULT_APPROVAL_POLICY);
	if (!raw || typeof raw !== 'object') {
		return base;
	}

	const obj = raw as Record<string, Partial<ApprovalRule>>;
	for (const key of Object.keys(base) as ApprovalActionType[]) {
		const item = obj[key];
		if (!item || typeof item !== 'object') {
			continue;
		}

		const mode = item.mode;
		base[key] = {
			mode: mode === 'allow' || mode === 'deny' || mode === 'review' || mode === 'ask' ? mode : base[key].mode,
			allowlist: Array.isArray(item.allowlist) ? item.allowlist.map(String) : base[key].allowlist,
			denylist: Array.isArray(item.denylist) ? item.denylist.map(String) : base[key].denylist,
		};
	}

	return base;
}
