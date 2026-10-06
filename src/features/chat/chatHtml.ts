import type { Uri } from 'vscode';
import type { WebviewL10nPack } from '../../l10n/loadBundle';

function escapeScriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderChatHtml(params: {
	cspSource: string;
	nonce: string;
	scriptUri: Uri;
	styleUri: Uri;
	codiconsStyleUri?: Uri;
	title?: string;
	screen?: 'chat' | 'settings';
	l10n: WebviewL10nPack;
}): string {
	const { cspSource, nonce, scriptUri, styleUri, l10n } = params;
	const title = params.title ?? l10n.strings['chat.webviewTitle'] ?? 'Haratsan Chat';
	const screen = params.screen ?? 'chat';
	const lang = l10n.locale || 'en';
	const codiconsLink = params.codiconsStyleUri
		? `\n\t<link href="${params.codiconsStyleUri}" rel="stylesheet">`
		: '';

	return `<!DOCTYPE html>
<html lang="${lang}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource} data:; script-src ${cspSource} 'nonce-${nonce}'; img-src https: data:;">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${title}</title>
	<link href="${styleUri}" rel="stylesheet">${codiconsLink}
</head>
<body data-screen="${screen}">
	<div id="root"></div>
	<script nonce="${nonce}">window.__HARATSAN_L10N__=${escapeScriptJson(l10n)};</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let i = 0; i < 32; i += 1) {
		value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}

	return value;
}
