import * as vscode from 'vscode';
import type { ChatMode } from '../../core/config/types';
import type { SlashCommand } from '../chat/slashCommands';

export interface CustomCommand {
	name: string;
	title?: string;
	description?: string;
	mode?: ChatMode;
	model?: string;
	body: string;
	path: string;
	// Описание аргументов из frontmatter `arguments:`
	argumentsHint?: string;
}

const MAX_BODY_CHARS = 32_000;
const MODES = new Set<ChatMode>(['ask', 'agent', 'debug', 'design', 'plan', 'multitask', 'project']);

export type CommandPlaceholders = {
	usesArguments: boolean;
	maxPositional: number;
	// Нужны непустые args (есть $ARGUMENTS или хотя бы $1)
	required: boolean;
};

// Разобрать плейсхолдеры $ARGUMENTS / $1...$n в теле команды
export function analyzeCommandPlaceholders(body: string): CommandPlaceholders {
	const usesArguments = /\$ARGUMENTS\b/.test(body);
	let maxPositional = 0;
	for (const m of body.matchAll(/\$(\d+)\b/g)) {
		maxPositional = Math.max(maxPositional, Number(m[1]));
	}

	return {
		usesArguments,
		maxPositional,
		required: usesArguments || maxPositional >= 1,
	};
}

// Проверка args перед expand (для UX / ChatSession)
export function validateCommandArgs(
	body: string,
	argsText: string,
): { ok: true } | { ok: false; message: string } {
	const meta = analyzeCommandPlaceholders(body);
	const trimmed = argsText.trim();
	if (!meta.required) {
		return { ok: true };
	}

	if (!trimmed) {
		if (meta.usesArguments) {
			return {
				ok: false,
				message: 'Нужны аргументы для $ARGUMENTS'
			};
		}

		return {
			ok: false,
			message: `Нужны аргументы: минимум ${meta.maxPositional} ($1...$${meta.maxPositional})`,
		};
	}

	if (meta.maxPositional > 0) {
		const parts = splitTemplateArgs(trimmed);
		if (parts.length < meta.maxPositional) {
			return {
				ok: false,
				message: `Мало аргументов: нужно ≥ ${meta.maxPositional}, сейчас ${parts.length}`,
			};
		}
	}

	return { ok: true };
}

function parseFrontmatter(raw: string): {
	title?: string;
	description?: string;
	mode?: ChatMode;
	model?: string;
	argumentsHint?: string;
	body: string;
} {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw.trim());
	if (!match) {
		return { body: raw.trim() };
	}

	const meta = match[1]!;
	const body = match[2]!.trim();
	const title = /^\s*title:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const description = /^\s*description:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const argumentsHint = /^\s*arguments:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const agentRaw = (/^\s*(?:agent|mode):\s*(.+)$/m.exec(meta)?.[1] ?? '').trim().toLowerCase();
	const model = /^\s*model:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const mode = MODES.has(agentRaw as ChatMode) ? (agentRaw as ChatMode) : undefined;
	return { title, description, mode, model, argumentsHint, body };
}

function fileStem(uri: vscode.Uri): string {
	const base = uri.path.split('/').pop() ?? 'command';
	return base.replace(/\.md$/i, '');
}

// Обнаружить кастомные slash-команды из `.haratsan/commands/*.md`
export async function discoverCustomCommands(): Promise<CustomCommand[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '.haratsan/commands/*.md'),
		undefined,
		80,
	);
	const out: CustomCommand[] = [];
	const seen = new Set<string>();

	for (const uri of uris) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const raw = new TextDecoder().decode(bytes);
			const parsed = parseFrontmatter(raw);
			const name = fileStem(uri).trim().toLowerCase();
			if (!name || !/^[a-z][\w-]*$/i.test(name) || seen.has(name)) {
				continue;
			}

			seen.add(name);
			const body = parsed.body.length > MAX_BODY_CHARS
				? `${parsed.body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`
				: parsed.body;
			out.push({
				name,
				title: parsed.title,
				description: parsed.description,
				mode: parsed.mode,
				model: parsed.model,
				argumentsHint: parsed.argumentsHint,
				body,
				path: vscode.workspace.asRelativePath(uri),
			});
		} catch {
			continue;
		}
	}

	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function customToSlashCommand(cmd: CustomCommand): SlashCommand {
	const placeholders = analyzeCommandPlaceholders(cmd.body);
	const argsHint = cmd.argumentsHint || (placeholders.usesArguments
		? '$ARGUMENTS'
		: placeholders.maxPositional > 0
			? [...Array(placeholders.maxPositional)].map((_, i) => `$${i + 1}`).join(' ')
			: undefined);
	const detailBase = cmd.description || cmd.title || cmd.name;
	return {
		id: `custom:${cmd.name}`,
		name: cmd.name,
		detail: placeholders.required && argsHint
			? `${detailBase}  ${argsHint}`
			: detailBase,
		mode: cmd.mode,
		needsArgs: placeholders.required,
		argsHint,
		minPositionalArgs: placeholders.maxPositional > 0 ? placeholders.maxPositional : undefined,
	};
}

// Подставить $ARGUMENTS и $1...$n в шаблон команды
export function expandCommandTemplate(body: string, argsText: string): string {
	const trimmed = argsText.trim();
	const parts = splitTemplateArgs(trimmed);
	let out = body.replace(/\$ARGUMENTS/g, trimmed);
	out = out.replace(/\$(\d+)/g, (_m, n: string) => {
		const idx = Number(n) - 1;
		return idx >= 0 && idx < parts.length ? parts[idx]! : '';
	});
	return out.trim();
}

function splitTemplateArgs(text: string): string[] {
	if (!text) {
		return [];
	}

	const parts: string[] = [];
	let cur = '';
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i]!;
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				cur += ch;
			}

			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}

		if (/\s/.test(ch)) {
			if (cur) {
				parts.push(cur);
				cur = '';
			}
			continue;
		}

		cur += ch;
	}

	if (cur) {
		parts.push(cur);
	}

	return parts;
}
