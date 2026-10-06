import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HARATSAN_DIR_RELATIVE } from '../project/config';
import { defaultWorkspaceCwd } from './shellSession';

export const REPORTS_DIR_RELATIVE = path.join(HARATSAN_DIR_RELATIVE, 'reports');

function slugify(raw: string): string {
	const base = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return base || `report-${Date.now().toString(36)}`;
}

/**
 * Записать synthesize-отчёт project/team-lead в `.haratsan/reports/<slug>.md`.
 * Не перезаписывает чужие файлы с тем же именем - добавляет суффикс.
 */
export async function writeProjectSynthesizeReport(params: {
	title: string;
	body: string;
	source?: 'task' | 'parallel-research' | 'manual';
	signal?: AbortSignal;
}): Promise<{ ok: boolean; relative?: string; absolute?: string; detail: string }> {
	const root = defaultWorkspaceCwd();
	const dir = path.join(root, REPORTS_DIR_RELATIVE);
	try {
		await fs.mkdir(dir, { recursive: true });
		let slug = slugify(params.title);
		let file = path.join(dir, `${slug}.md`);
		let n = 0;
		while (n < 20) {
			try {
				await fs.access(file);
				n += 1;
				slug = `${slugify(params.title)}-${n}`;
				file = path.join(dir, `${slug}.md`);
			} catch {
				break;
			}
		}

		const header = [
			`# ${params.title.trim() || 'Synthesize report'}`,
			'',
			`_source: ${params.source ?? 'task'} ${new Date().toISOString()}_`,
			'',
		].join('\n');
		const text = `${header}${params.body.trim()}\n`;
		if (params.signal?.aborted) {
			const err = new Error('AbortError');
			err.name = 'AbortError';
			throw err;
		}

		await fs.writeFile(file, text, 'utf8');
		const relative = path.posix.join(HARATSAN_DIR_RELATIVE, 'reports', `${slug}.md`);
		return {
			ok: true,
			relative,
			absolute: file,
			detail: `written ${relative}`,
		};
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw err;
		}

		return {
			ok: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// Краткая сводка results[] для markdown synthesize
export function formatResearchAggregateMarkdown(
	results: Array<{ ok: boolean; jobId: string; subagent: string; report?: string; error?: string }>,
): string {
	const lines: string[] = ['## Aggregate', ''];
	for (const [i, r] of results.entries()) {
		lines.push(`### ${i + 1}. ${r.subagent} (\`${r.jobId}\`) - ${r.ok ? 'ok' : 'fail'}`);
		lines.push('');
		lines.push(r.ok ? (r.report ?? '(empty)') : (r.error ?? 'error'));
		lines.push('');
	}
	return lines.join('\n');
}

// Открыть отчёт в редакторе (best-effort)
export async function revealProjectReport(absolutePath: string): Promise<void> {
	try {
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
		await vscode.window.showTextDocument(doc, { preview: true });
	} catch {
		// ignore
	}
}
