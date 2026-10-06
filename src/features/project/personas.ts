import * as vscode from 'vscode';

const PERSONAS_GLOB = '.haratsan/personas/*.md';
const MAX_BODY_CHARS = 8_000;

export type PersonaSource = 'builtin' | 'custom';

export interface PersonaInfo {
	id: string;
	name: string;
	description: string;
	body: string;
	// Workspace-relative путь; у builtin может быть пустым
	path: string;
	source: PersonaSource;
}

// Встроенные персоны (без файла на диске). Пока пусто - слот для будущих пресетов
export const BUILTIN_PERSONAS: ReadonlyArray<Omit<PersonaInfo, 'path'> & { path?: string }> = [];

function parseFrontmatter(raw: string): {
	name?: string;
	description?: string;
	body: string;
} {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw.trim());
	if (!match) {
		return { 
			body: raw.trim() 
		};
	}

	const meta = match[1]!;
	const body = match[2]!.trim();
	const name = /^\s*name:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	const description = /^\s*description:\s*(.+)$/m.exec(meta)?.[1]?.trim();
	return { 
		name, 
		description, 
		body 
	};
}

function slugify(name: string): string {
	return name.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9_-]/g, '')
		.slice(0, 48) || 'persona';
}

function listBuiltinPersonas(): PersonaInfo[] {
	return BUILTIN_PERSONAS.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description,
		body: p.body,
		path: p.path ?? '',
		source: 'builtin' as const,
	}));
}

// Найти персоны в `.haratsan/personas/*.md` (frontmatter name/description)
export async function discoverCustomPersonas(): Promise<PersonaInfo[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, PERSONAS_GLOB), undefined, 40);
	const out: PersonaInfo[] = [];
	const seen = new Set<string>();

	for (const uri of uris) {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const raw = new TextDecoder().decode(bytes);
			const parsed = parseFrontmatter(raw);
			const fileBase = (uri.path.split('/').pop() ?? 'persona').replace(/\.md$/i, '');
			const name = (parsed.name || fileBase).trim();
			const id = slugify(name);
			if (seen.has(id)) {
				continue;
			}

			seen.add(id);
			const body = parsed.body.length > MAX_BODY_CHARS
				? `${parsed.body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`
				: parsed.body;
			out.push({
				id,
				name,
				description: parsed.description || name,
				body,
				path: vscode.workspace.asRelativePath(uri),
				source: 'custom',
			});
		} catch {
			continue;
		}
	}

	return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// Builtin (если есть) + кастомные из `.haratsan/personas/*.md` (кастом перекрывает тот же id)
export async function discoverPersonas(): Promise<PersonaInfo[]> {
	const byId = new Map<string, PersonaInfo>();
	for (const p of listBuiltinPersonas()) {
		byId.set(p.id, p);
	}

	for (const p of await discoverCustomPersonas()) {
		byId.set(p.id, p);
	}

	return [...byId.values()].sort((a, b) => {
		if (a.source !== b.source) {
			return a.source === 'builtin' ? -1 : 1;
		}
		
		return a.name.localeCompare(b.name, 'ru');
	});
}

export async function resolvePersona(personaId: string): Promise<PersonaInfo | undefined> {
	const id = personaId.trim().toLowerCase();
	if (!id) {
		return undefined;
	}

	const list = await discoverPersonas();
	return list.find((p) => p.id === id || p.name.toLowerCase() === id);
}

// Фрагмент для system prompt
export function formatPersonaAppendix(persona: PersonaInfo): string {
	const lines = [
		`## Персона: ${persona.name}`,
		persona.description ? `Описание: ${persona.description}` : '',
		persona.body || '',
	].filter(Boolean);
	return lines.join('\n');
}
