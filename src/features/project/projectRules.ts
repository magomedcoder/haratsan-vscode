import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import { getHaratsanUserAgentsPath } from '../../core/config/userPaths';
import { fetchHttpsText } from './fetchHttpsText';
import { formatHaratsanRulesForPrompt, HARATSAN_RULES_RELATIVE, MAX_HARATSAN_RULES_CHARS, normalizeHaratsanRulesText } from './haratsanRules';

const RULE_FILES = [
	HARATSAN_RULES_RELATIVE,
	'AGENTS.md',
];

const MAX_INSTRUCTION_URL_CHARS = 12_000;
const MAX_INSTRUCTION_URLS = 8;

// Кандидат правил для UI настроек (без чтения содержимого)
export interface RuleCandidate {
	label: string;
	path: string;
	exists: boolean;
}

async function pathExistsUri(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function pathExistsFs(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

// Список путей правил, которые могут попасть в prompt (только stat, без чтения текста)
export async function listRulesCandidates(): Promise<RuleCandidate[]> {
	const out: RuleCandidate[] = [];
	const folder = vscode.workspace.workspaceFolders?.[0];

	if (folder) {
		for (const rel of RULE_FILES) {
			const uri = vscode.Uri.joinPath(folder.uri, rel);
			out.push({
				label: rel,
				path: uri.fsPath,
				exists: await pathExistsUri(uri),
			});
		}
	} else {
		for (const rel of RULE_FILES) {
			out.push({ 
				label: rel, 
				path: rel, 
				exists: false
			});
		}
	}

	const userPath = getHaratsanUserAgentsPath();
	out.push({
		label: '~/.config/haratsan/AGENTS.md',
		path: userPath,
		exists: await pathExistsFs(userPath),
	});

	const urls = getSettings().instructionUrls.slice(0, MAX_INSTRUCTION_URLS);
	for (const url of urls) {
		const trimmed = url.trim();
		if (!trimmed) {
			continue;
		}
		out.push({
			label: `remote:${trimmed}`,
			path: trimmed,
			exists: true,
		});
	}

	return out;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

async function readUserAgentsMd(): Promise<{ text: string; label: string } | undefined> {
	const filePath = getHaratsanUserAgentsPath();
	try {
		const text = await fs.readFile(filePath, 'utf8');
		return { text, label: '~/.config/haratsan/AGENTS.md' };
	} catch {
		return undefined;
	}
}

async function loadInstructionUrlsAppendix(): Promise<string[]> {
	const urls = getSettings().instructionUrls.slice(0, MAX_INSTRUCTION_URLS);
	if (urls.length === 0) {
		return [];
	}

	const chunks: string[] = [];
	for (const url of urls) {
		const result = await fetchHttpsText(url, MAX_INSTRUCTION_URL_CHARS);
		if (!result.ok) {
			continue;
		}

		const normalized = normalizeHaratsanRulesText(result.text);
		if (normalized) {
			chunks.push(`### remote:${result.url}\n${normalized}`);
		}
	}
	return chunks;
}

// Собрать haratsanRules + AGENTS.md (+ user-level + instructionUrls) в appendix к prompt
export async function loadProjectRulesAppendix(): Promise<string | undefined> {
	const chunks: string[] = [];
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		for (const rel of RULE_FILES) {
			const text = await readText(vscode.Uri.joinPath(folder.uri, rel));
			const normalized = text ? normalizeHaratsanRulesText(text) : undefined;
			if (normalized) {
				chunks.push(`### ${rel}\n${normalized}`);
			}
		}
	}

	// User-level правила - после проектных
	const userFile = await readUserAgentsMd();
	const userNormalized = userFile ? normalizeHaratsanRulesText(userFile.text) : undefined;
	if (userNormalized && userFile) {
		chunks.push(`### ${userFile.label}\n${userNormalized}`);
	}

	chunks.push(...(await loadInstructionUrlsAppendix()));

	if (chunks.length === 0) {
		return undefined;
	}

	let merged = chunks.join('\n\n');
	if (merged.length > MAX_HARATSAN_RULES_CHARS * 2) {
		merged = `${merged.slice(0, MAX_HARATSAN_RULES_CHARS * 2)}\n\n[Haratsan: rules truncated]`;
	}

	return formatHaratsanRulesForPrompt(merged);
}
