import type { WebviewL10nPack } from '../l10n/loadBundle';

declare global {
	interface Window {
		__HARATSAN_L10N__?: WebviewL10nPack;
	}
}

function pack(): WebviewL10nPack {
	return window.__HARATSAN_L10N__ ?? { 
		locale: 'en',
		strings: {}
	};
}

// Локализация webview: строки приходят из extension host (l10n/*.json)
export function t(key: string, ...args: Array<string | number>): string {
	const template = pack().strings[key] ?? key;
	return template.replace(/\{(\d+)\}/g, (_, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? `{${index}}` : String(value);
	});
}
