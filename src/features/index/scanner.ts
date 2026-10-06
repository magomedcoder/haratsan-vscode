import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import { getFolderIgnoreMatcher, ignoresRelative } from '../agent/gitIgnore';
import { AGENT_LIMITS, deniedDirectoryExcludeGlob, isDeniedRelativePath, looksBinary, toPosixRelative } from '../agent/policy';

export const INDEX_SCAN_LIMITS = {
	maxFiles: 4_000,
} as const;

const INDEX_EXCLUDE_GLOBS = ['**/.haratsan/**'];

function buildExcludePattern(deniedPaths: readonly string[]): string {
	const parts = [...INDEX_EXCLUDE_GLOBS];
	const denied = deniedDirectoryExcludeGlob(deniedPaths);
	if (denied) {
		parts.push(denied);
	}

	return `{${parts.join(',')}}`;
}

export interface ScannedFile {
	uri: vscode.Uri;
	relative: string;
}

export async function listIndexableFiles(folder: vscode.WorkspaceFolder): Promise<ScannedFile[]> {
	const settings = getSettings();
	const exclude = buildExcludePattern(settings.deniedPaths);
	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '**/*'),
		exclude,
		INDEX_SCAN_LIMITS.maxFiles,
	);

	const matcher = await getFolderIgnoreMatcher(folder.uri.fsPath);
	const out: ScannedFile[] = [];

	for (const uri of uris) {
		const relative = toPosixRelative(vscode.workspace.asRelativePath(uri, false));
		if (!relative || relative.startsWith('.haratsan/')) {
			continue;
		}

		if (ignoresRelative(matcher, relative)) {
			continue;
		}

		if (isDeniedRelativePath(relative, settings.deniedPaths)) {
			continue;
		}

		out.push({ uri, relative });
	}

	return out;
}

export async function readIndexableText(uri: vscode.Uri): Promise<string | undefined> {
	let raw: Uint8Array;
	try {
		raw = await vscode.workspace.fs.readFile(uri);
	} catch {
		return undefined;
	}

	if (looksBinary(raw) || raw.byteLength > AGENT_LIMITS.maxReadBytes) {
		return undefined;
	}

	return new TextDecoder('utf8', { 
		fatal: false 
	}).decode(raw);
}
