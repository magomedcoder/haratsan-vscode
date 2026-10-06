import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import { fetchHttpsText } from './fetchHttpsText';

export interface SkillInfo {
	name: string;
	description: string;
	path: string;
	body: string;
}

const MAX_SKILL_CHARS = 16_000;
const MAX_SKILL_URLS = 12;
const BUILTIN_SKILL_GLOBS = [
	'.haratsan/skills/*/SKILL.md',
	'.agents/skills/*/SKILL.md',
];

function skillNameFromUrl(url: string): string {
	try {
		const u = new URL(url);
		const parts = u.pathname.split('/').filter(Boolean);
		const last = parts[parts.length - 1] ?? 'skill';
		const base = last.replace(/\.md$/i, '').replace(/^skill$/i, '') || parts[parts.length - 2] || 'remote-skill';
		return base.trim() || 'remote-skill';
	} catch {
		return 'remote-skill';
	}
}

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw.trim());
	if (!match) {
		return { body: raw.trim() };
	}

	const meta = match[1]!;
	const body = match[2]!.trim();
	const name = /^\s*name:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const description = /^\s*description:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	return { name, description, body };
}

function skillGlobsFromExtraDirs(dirs: string[]): string[] {
	const out: string[] = [];
	for (const raw of dirs) {
		const dir = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
		if (!dir || dir.startsWith('#')) {
			continue;
		}

		// Абсолютные пути не через RelativePattern workspace - пропустим, обработаем отдельно
		if (dir.startsWith('/') || /^[a-zA-Z]:\//.test(dir)) {
			continue;
		}

		out.push(`${dir}/*/SKILL.md`);
		out.push(`${dir}/SKILL.md`);
	}
	return out;
}

async function readSkillUri(uri: vscode.Uri, seen: Set<string>, out: SkillInfo[]): Promise<void> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const raw = new TextDecoder().decode(bytes);
		const parsed = parseFrontmatter(raw);
		const parts = uri.path.split('/');
		const folderName = parts[parts.length - 2] ?? 'skill';
		const fileBase = (parts[parts.length - 1] ?? 'skill').replace(/\.md$/i, '');
		const name = (parsed.name || (fileBase.toLowerCase() === 'skill' ? folderName : fileBase)).trim();
		if (seen.has(name.toLowerCase())) {
			return;
		}

		seen.add(name.toLowerCase());
		const body = parsed.body.length > MAX_SKILL_CHARS
			? `${parsed.body.slice(0, MAX_SKILL_CHARS)}\n\n[truncated]`
			: parsed.body;
		out.push({
			name,
			description: parsed.description || name,
			path: vscode.workspace.asRelativePath(uri),
			body,
		});
	} catch {
		// пропуск битого skill
	}
}

async function loadRemoteSkills(seen: Set<string>, out: SkillInfo[]): Promise<void> {
	const urls = getSettings().skillsUrls.slice(0, MAX_SKILL_URLS);
	for (const url of urls) {
		const result = await fetchHttpsText(url, MAX_SKILL_CHARS);
		if (!result.ok) {
			continue;
		}

		const parsed = parseFrontmatter(result.text);
		const name = (parsed.name || skillNameFromUrl(result.url)).trim();
		if (!name || seen.has(name.toLowerCase())) {
			continue;
		}

		seen.add(name.toLowerCase());
		const body = parsed.body.length > MAX_SKILL_CHARS
			? `${parsed.body.slice(0, MAX_SKILL_CHARS)}\n\n[truncated]`
			: parsed.body;
		out.push({
			name,
			description: parsed.description || name,
			path: result.url,
			body,
		});
	}
}

export async function discoverSkills(extraPaths?: string[]): Promise<SkillInfo[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const settingsPaths = extraPaths ?? getSettings().skillsPaths;
	const out: SkillInfo[] = [];
	const seen = new Set<string>();

	if (folder) {
		const globs = [...BUILTIN_SKILL_GLOBS, ...skillGlobsFromExtraDirs(settingsPaths)];
		for (const glob of globs) {
			const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), undefined, 40);
			for (const uri of uris) {
				await readSkillUri(uri, seen, out);
			}
		}

		// Абсолютные доп. каталоги из settings
		for (const raw of settingsPaths) {
			const dir = raw.trim();
			if (!dir.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(dir)) {
				continue;
			}

			const base = vscode.Uri.file(dir);
			for (const rel of ['SKILL.md', '*/SKILL.md']) {
				if (rel.includes('*')) {
					try {
						const entries = await vscode.workspace.fs.readDirectory(base);
						for (const [name, kind] of entries) {
							if (kind !== vscode.FileType.Directory) {
								continue;
							}

							await readSkillUri(vscode.Uri.joinPath(base, name, 'SKILL.md'), seen, out);
						}
					} catch {
						continue;
					}
				} else {
					await readSkillUri(vscode.Uri.joinPath(base, 'SKILL.md'), seen, out);
				}
			}
		}
	}

	await loadRemoteSkills(seen, out);
	return out;
}

export function formatSkillsCatalog(skills: SkillInfo[]): string | undefined {
	if (skills.length === 0) {
		return undefined;
	}

	const lines = skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`);
	return `Доступные skills (загрузи через tool skill по имени):\n${lines.join('\n')}`;
}
