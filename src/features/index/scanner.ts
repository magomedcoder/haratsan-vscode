import * as vscode from 'vscode';
import { getFolderIgnoreMatcher, ignoresRelative } from '../agent/gitIgnore';
import { AGENT_LIMITS, looksBinary, toPosixRelative } from '../agent/policy';

export const INDEX_SCAN_LIMITS = {
	maxFiles: 4_000,
} as const;

const INDEX_EXCLUDE = '{**/.haratsan/**,**/.git/**,**/node_modules/**}';

export interface ScannedFile {
	uri: vscode.Uri;
	relative: string;
}

export async function listIndexableFiles(folder: vscode.WorkspaceFolder): Promise<ScannedFile[]> {
	const uris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '**/*'),
		INDEX_EXCLUDE,
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

	return Buffer.from(raw).toString('utf8');
}
