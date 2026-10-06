import * as vscode from 'vscode';
import { serializePlanMarkdown } from './planFile';
import type { StickyPlanSnapshot } from './plan';

export const PLANS_DIR_RELATIVE = '.haratsan/plans';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// Нормализовать slug для `.haratsan/plans/<slug>.md`
export function normalizePlanSlug(raw: string): string | undefined {
	const slug = raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
	if (!slug || !SLUG_RE.test(slug)) {
		return undefined;
	}

	return slug;
}

export function planSlugRelativePath(slug: string): string {
	return `${PLANS_DIR_RELATIVE}/${slug}.md`;
}

function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function resolvePlanSlugUri(slug: string): vscode.Uri | undefined {
	const root = workspaceRoot();
	if (!root) {
		return undefined;
	}

	return vscode.Uri.joinPath(root, PLANS_DIR_RELATIVE, `${slug}.md`);
}

async function ensurePlansDir(): Promise<vscode.Uri | undefined> {
	const root = workspaceRoot();
	if (!root) {
		return undefined;
	}

	const dir = vscode.Uri.joinPath(root, PLANS_DIR_RELATIVE);
	try {
		await vscode.workspace.fs.stat(dir);
	} catch {
		await vscode.workspace.fs.createDirectory(dir);
	}

	return dir;
}

// Записать снимок плана в `.haratsan/plans/<slug>.md` (не трогает sticky `.haratsan/plan.md`)
export async function writeNamedPlan(slug: string, snap: StickyPlanSnapshot): Promise<{ relativePath: string }> {
	const normalized = normalizePlanSlug(slug);
	if (!normalized) {
		throw new Error(`Некорректный slug плана: «${slug}». Используй латиницу, цифры, _ и -`);
	}

	const uri = resolvePlanSlugUri(normalized);
	if (!uri) {
		throw new Error('Нет открытого workspace');
	}

	await ensurePlansDir();
	const markdown = serializePlanMarkdown(snap);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(markdown));
	return { relativePath: planSlugRelativePath(normalized) };
}

// Список файлов `.haratsan/plans/*.md`
export async function listNamedPlans(): Promise<Array<{ slug: string; relativePath: string }>> {
	const root = workspaceRoot();
	if (!root) {
		return [];
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, `${PLANS_DIR_RELATIVE}/*.md`),
		undefined,
		80,
	);

	return uris.map((uri) => {
		const relativePath = vscode.workspace.asRelativePath(uri);
		const base = relativePath.split(/[/\\]/).pop() ?? '';
		const slug = base.replace(/\.md$/i, '');
		return { slug, relativePath };
	})
		.filter((p) => Boolean(p.slug))
		.sort((a, b) => a.slug.localeCompare(b.slug));
}
