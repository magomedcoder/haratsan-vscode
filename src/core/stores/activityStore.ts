import type { ExtensionContext, Memento } from 'vscode';
import { isMutatingTool } from '../../features/agent/auth';

// Вид действия в Activity ledger (вне message history)
export type ActivityKind = 'tool' | 'edit' | 'shell' | 'review';

export interface ActivityEntry {
	id: string;
	// Epoch мс
	at: number;
	kind: ActivityKind;
	// Краткая подпись для UI
	label: string;
	path?: string;
	sessionId?: string;
	// Имя tool / действие (accept, reject, ...)
	toolName?: string;
	// pending | ok | error | denied | start
	status?: string;
}

const STORAGE_KEY = 'haratsan.activity.entries';
const MAX_ENTRIES = 200;

const SHELL_TOOLS = new Set(['run_command', 'run_tests', 'await_shell', 'run_scratch']);

let store: Memento | undefined;
let entries: ActivityEntry[] = [];

function newId(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function initActivityStore(context: ExtensionContext): void {
	store = context.globalState;
	const raw = store.get<ActivityEntry[]>(STORAGE_KEY, []);
	entries = Array.isArray(raw) ? raw.slice(0, MAX_ENTRIES) : [];
}

function persist(): void {
	void store?.update(STORAGE_KEY, entries);
}

// Классификация tool * kind для ledger
export function activityKindFromTool(name: string): ActivityKind {
	if (SHELL_TOOLS.has(name)) {
		return 'shell';
	}

	if (isMutatingTool(name)) {
		return 'edit';
	}

	return 'tool';
}

// Краткая подпись из имени tool + args/path
export function summarizeToolActivity(
	name: string,
	rawArgs: string,
	path?: string,
): string {
	const trimmedPath = path?.trim();
	if (trimmedPath) {
		return `${name}: ${trimmedPath}`;
	}

	try {
		const args = JSON.parse(rawArgs) as Record<string, unknown>;
		if (typeof args.command === 'string' && args.command.trim()) {
			return `${name}: ${args.command.trim().slice(0, 100)}`;
		}

		if (typeof args.toolName === 'string' && args.toolName.trim()) {
			const server = typeof args.server === 'string' ? args.server.trim() : '';
			return server
				? `${name}: ${server}/${args.toolName.trim()}`
				: `${name}: ${args.toolName.trim()}`;
		}

		if (name === 'execute' && Array.isArray(args.steps) && args.steps.length > 0) {
			const first = args.steps[0] as { tool?: unknown };
			if (typeof first?.tool === 'string' && first.tool.trim()) {
				return `${name}: ${first.tool.trim()}${args.steps.length > 1 ? ` (+${args.steps.length - 1})` : ''}`;
			}
		}

		if (typeof args.query === 'string' && args.query.trim()) {
			return `${name}: ${args.query.trim().slice(0, 80)}`;
		}

		if (typeof args.pattern === 'string' && args.pattern.trim()) {
			return `${name}: ${args.pattern.trim().slice(0, 80)}`;
		}

		if (typeof args.url === 'string' && args.url.trim()) {
			return `${name}: ${args.url.trim().slice(0, 80)}`;
		}
	} catch {}

	return name;
}

export function recordActivity(input: {
	kind: ActivityKind;
	label: string;
	path?: string;
	sessionId?: string;
	toolName?: string;
	status?: string;
}): void {
	const label = input.label.trim();
	if (!label) {
		return;
	}

	const entry: ActivityEntry = {
		id: newId(),
		at: Date.now(),
		kind: input.kind,
		label: label.slice(0, 240),
		...(input.path?.trim() ? { path: input.path.trim() } : {}),
		...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
		...(input.toolName?.trim() ? { toolName: input.toolName.trim() } : {}),
		...(input.status?.trim() ? { status: input.status.trim() } : {}),
	};

	entries = [entry, ...entries].slice(0, MAX_ENTRIES);
	persist();
}

export function readActivity(): ActivityEntry[] {
	return entries.map((e) => ({ ...e }));
}

export function clearActivity(): void {
	entries = [];
	persist();
}
