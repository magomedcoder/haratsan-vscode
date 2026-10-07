import * as vscode from 'vscode';
import { formatMentionPathArg, type MentionKind } from './mentions';
import { getSessionPeek } from './sessionStore';
import { loadReferenceDefs } from '../project/references';

export interface MentionSuggestion {
	kind: MentionKind;
	label: string;
	insert: string;
	detail?: string;
}

function kindTemplates(): Array<{
	kind: MentionKind;
	label: string;
	insert: string;
	detail: string;
}> {
	return [
		{
			kind: 'file',
			label: '@file',
			insert: '@file ',
			detail: vscode.l10n.t('chat.mention.detail.file'),
		},
		{
			kind: 'folder',
			label: '@folder',
			insert: '@folder ',
			detail: vscode.l10n.t('chat.mention.detail.folder'),
		},
		{
			kind: 'codebase',
			label: '@codebase',
			insert: '@codebase ',
			detail: vscode.l10n.t('chat.mention.detail.codebase'),
		},
		{
			kind: 'map',
			label: '@map',
			insert: '@map',
			detail: vscode.l10n.t('chat.mention.detail.map'),
		},
		{
			kind: 'symbols',
			label: '@symbols',
			insert: '@symbols ',
			detail: vscode.l10n.t('chat.mention.detail.symbols'),
		},
		{
			kind: 'code',
			label: '@code',
			insert: '@code',
			detail: vscode.l10n.t('chat.mention.detail.code'),
		},
		{
			kind: 'docs',
			label: '@Docs',
			insert: '@Docs ',
			detail: vscode.l10n.t('chat.mention.detail.docs'),
		},
		{
			kind: 'agent',
			label: '@agent',
			insert: '@agent ',
			detail: vscode.l10n.t('chat.mention.detail.agent'),
		},
		{
			kind: 'alias',
			label: '@alias',
			insert: '@alias ',
			detail: vscode.l10n.t('chat.mention.detail.alias'),
		},
		{
			kind: 'ref',
			label: '@ref',
			insert: '@ref:',
			detail: vscode.l10n.t('chat.mention.detail.ref'),
		},
		{
			kind: 'git',
			label: '@git',
			insert: '@git ',
			detail: vscode.l10n.t('chat.mention.detail.git'),
		},
		{
			kind: 'branch_diff',
			label: '@branch_diff',
			insert: '@branch_diff',
			detail: vscode.l10n.t('chat.mention.detail.branchDiff'),
		},
		{
			kind: 'git_changes',
			label: '@git-changes',
			insert: '@git-changes',
			detail: vscode.l10n.t('chat.mention.detail.gitChanges'),
		},
		{
			kind: 'problems',
			label: '@problems',
			insert: '@problems',
			detail: vscode.l10n.t('chat.mention.detail.problems'),
		},
		{
			kind: 'rules',
			label: '@rules',
			insert: '@rules',
			detail: vscode.l10n.t('chat.mention.detail.rules'),
		},
		{
			kind: 'link',
			label: '@link',
			insert: '@link ',
			detail: vscode.l10n.t('chat.mention.detail.link'),
		},
		{
			kind: 'terminals',
			label: '@terminals',
			insert: '@terminals',
			detail: vscode.l10n.t('chat.mention.detail.terminals'),
		},
		{
			kind: 'past',
			label: '@past',
			insert: '@past ',
			detail: vscode.l10n.t('chat.mention.detail.past'),
		},
	];
}

const KIND_NAMES: MentionKind[] = ['file', 'folder', 'codebase', 'map', 'symbols', 'code', 'docs', 'agent', 'alias', 'ref', 'git', 'git_changes', 'branch_diff', 'problems', 'rules', 'link', 'terminals', 'past'];

async function suggestReferenceAliases(prefix: string): Promise<MentionSuggestion[]> {
	const isRef = prefix.startsWith('ref');
	const kind: MentionKind = isRef ? 'ref' : 'alias';
	const nameQuery = prefix.replace(/^(alias|ref)\s+/, '')
		.replace(/^(alias|ref):/, '')
		.trim();
	const defs = await loadReferenceDefs();
	const out: MentionSuggestion[] = [];

	if (!nameQuery) {
		out.push({
			kind,
			label: isRef ? '@ref' : '@alias',
			insert: isRef ? '@ref:' : '@alias ',
			detail: vscode.l10n.t(isRef ? 'chat.mention.detail.ref' : 'chat.mention.detail.alias'),
		});
	}

	for (const def of defs) {
		if (nameQuery && !def.alias.toLowerCase().includes(nameQuery.toLowerCase())) {
			continue;
		}

		const detail = def.description
			?? (def.git ? `git ${def.git}` : def.path)
			?? vscode.l10n.t('chat.mention.kind.alias');
		out.push({
			kind: 'alias',
			label: `@alias ${def.alias}`,
			insert: `@alias ${def.alias} `,
			detail,
		});
		if (out.length >= 12) {
			break;
		}
	}

	return out.length
		? out
		: [{
			kind,
			label: isRef ? '@ref' : '@alias',
			insert: isRef ? '@ref:' : '@alias ',
			detail: vscode.l10n.t(isRef ? 'chat.mention.detail.ref' : 'chat.mention.detail.alias'),
		}];
}

export async function suggestMentions(query: string): Promise<MentionSuggestion[]> {
	const q = query.trim().toLowerCase();
	const prefix = q.replace(/^@/, '');

	if (!prefix || KIND_NAMES.some((k) => k.startsWith(prefix) || prefix.startsWith(k))) {
		const kindHits = kindTemplates().filter((k) => k.kind.startsWith(prefix) || prefix.length === 0 || prefix.startsWith(k.kind));
		if (!prefix.includes(' ') && !/[./]/.test(prefix) || kindHits.some((k) => k.kind === 'branch_diff' || k.kind === 'git_changes' || k.kind === 'problems' || k.kind === 'rules' || k.kind === 'code' || k.kind === 'terminals' || k.kind === 'past' || k.kind === 'alias' || k.kind === 'ref')) {
			if (!prefix.includes('/') && !prefix.includes('.')) {
				const hits = kindTemplates().filter((k) => !prefix || k.kind.startsWith(prefix) || k.kind.includes(prefix) || k.label.toLowerCase().includes(prefix) || (prefix === 'doc' && k.kind === 'docs') || (prefix.startsWith('git') && (k.kind === 'git' || k.kind === 'git_changes')));
				// @past / @alias / @ref - сразу список значений, не только шаблон kind
				if (hits.length && !prefix.includes(' ') && prefix !== 'past' && prefix !== 'alias' && prefix !== 'ref') {
					return hits.map((k) => ({
						kind: k.kind,
						label: k.label,
						insert: k.insert,
						detail: k.detail,
					}));
				}
			}
		}
	}

	if (prefix.startsWith('git')) {
		return [{
			kind: 'git',
			label: '@git HEAD',
			insert: '@git HEAD ',
			detail: vscode.l10n.t('chat.mention.detail.gitShow'),
		}];
	}

	if (prefix.startsWith('past')) {
		const store = getSessionPeek();
		const nameQuery = prefix.replace(/^past\s+/, '').replace(/^past:/, '').trim();
		const sessions = store?.listSessions() ?? [];
		const currentId = store?.getCurrentSessionId();
		const out: MentionSuggestion[] = [];

		if (!nameQuery) {
			out.push({
				kind: 'past',
				label: '@past',
				insert: '@past',
				detail: vscode.l10n.t('chat.mention.detail.past'),
			});
		}

		for (const s of sessions) {
			if (s.id === currentId) {
				continue;
			}

			if (nameQuery) {
				const n = nameQuery.toLowerCase();
				if (!s.title.toLowerCase().includes(n) && !s.id.toLowerCase().includes(n)) {
					continue;
				}
			}
			
			const needsQuotes = /\s/.test(s.title) || /@/.test(s.title);
			const arg = needsQuotes ? `\`${s.title}\`` : s.title;
			out.push({
				kind: 'past',
				label: `@past ${s.title}`,
				insert: `@past ${arg} `,
				detail: vscode.l10n.t('chat.mention.kind.past'),
			});
			if (out.length >= 12) {
				break;
			}
		}

		return out.length
			? out
			: [{
				kind: 'past',
				label: '@past',
				insert: '@past',
				detail: vscode.l10n.t('chat.mention.detail.past'),
			}];
	}

	if (prefix.startsWith('alias') || prefix.startsWith('ref')) {
		return suggestReferenceAliases(prefix);
	}

	if (prefix.startsWith('agent')) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return [{
				kind: 'agent',
				label: '@agent',
				insert: '@agent ',
				detail: vscode.l10n.t('chat.mention.detail.agent'),
			}];
		}

		const nameQuery = prefix.replace(/^agent\s+/, '').replace(/^agent:/, '').trim();
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, '.haratsan/agents/*.md'),
			undefined,
			30,
		);
		const out: MentionSuggestion[] = [];
		for (const uri of uris) {
			const base = (uri.path.split('/').pop() ?? '').replace(/\.md$/i, '');
			if (nameQuery && !base.toLowerCase().includes(nameQuery.toLowerCase())) {
				continue;
			}

			out.push({
				kind: 'agent',
				label: `@agent ${base}`,
				insert: `@agent ${base} `,
				detail: vscode.l10n.t('chat.mention.kind.agent'),
			});
			
			if (out.length >= 12) {
				break;
			}
		}
		return out.length
			? out
			: [{
				kind: 'agent',
				label: '@agent',
				insert: '@agent ',
				detail: vscode.l10n.t('chat.mention.detail.agent'),
			}];
	}

	if (prefix.startsWith('docs') || prefix.startsWith('doc')) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const pathQuery = prefix.replace(/^(docs?)\s+/, '').replace(/^(docs?):/, '').trim();
		if (!folder) {
			return [{
				kind: 'docs',
				label: '@Docs',
				insert: '@Docs ',
				detail: vscode.l10n.t('chat.mention.detail.docs'),
			}];
		}

		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, pathQuery ? `**/*${pathQuery.replace(/[^\w./-]/g, '')}*.md` : '{docs,Documentation,doc}/**/*.md'),
			'**/{.haratsan,node_modules,.git}/**',
			20,
		);
		const out: MentionSuggestion[] = uris.slice(0, 12).map((uri) => {
			const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
			return {
				kind: 'docs' as const,
				label: relative,
				insert: `@Docs ${relative} `,
				detail: vscode.l10n.t('chat.mention.kind.docs'),
			};
		});
		return out.length
			? out
			: [{
				kind: 'docs',
				label: '@Docs',
				insert: '@Docs ',
				detail: vscode.l10n.t('chat.mention.detail.docs'),
			}];
	}

	// Прямое совпадение имени alias (например @sdk), если не kind
	if (prefix && !prefix.includes(' ') && !/[./]/.test(prefix)) {
		const defs = await loadReferenceDefs();
		const aliasHits = defs.filter((d) => d.alias.toLowerCase().startsWith(prefix) || d.alias.toLowerCase().includes(prefix));
		if (aliasHits.length) {
			return aliasHits.slice(0, 12).map((def) => ({
				kind: 'alias' as const,
				label: `@alias ${def.alias}`,
				insert: `@alias ${def.alias} `,
				detail: def.description
					?? (def.git ? `git ${def.git}` : def.path)
					?? vscode.l10n.t('chat.mention.kind.alias'),
			}));
		}
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return [];
	}

	const pathQuery = prefix.replace(/^(file|folder|codebase|git|link|docs|agent|alias|ref)\s+/, '')
		.replace(/^(file|folder|codebase|git|link|docs|agent|alias|ref):/, '')
		.trim();

	const kind: 'file' | 'folder' = prefix.startsWith('folder') ? 'folder' : 'file';

	const glob = pathQuery ? `**/*${pathQuery.replace(/[^\w./-]/g, '')}*` : '**/*';

	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, glob),
		'**/{.haratsan,node_modules,.git}/**',
		30,
	);

	const seen = new Set<string>();
	const out: MentionSuggestion[] = [];

	for (const uri of uris) {
		const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
		if (!relative || seen.has(relative)) {
			continue;
		}

		seen.add(relative);
		if (kind === 'folder') {
			const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : relative;
			if (!dir || seen.has(`dir:${dir}`)) {
				continue;
			}

			seen.add(`dir:${dir}`);
			out.push({
				kind: 'folder',
				label: dir,
				insert: `@folder ${formatMentionPathArg(dir)} `,
				detail: vscode.l10n.t('chat.mention.kind.folder'),
			});
		} else {
			out.push({
				kind: 'file',
				label: relative,
				insert: `@file ${formatMentionPathArg(relative)} `,
				detail: vscode.l10n.t('chat.mention.kind.file'),
			});
		}

		if (out.length >= 12) {
			break;
		}
	}

	return out;
}
