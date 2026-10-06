import * as vscode from 'vscode';
import { matchAdminPattern } from '../config/adminPolicy';
import type { HaratsanSettings } from '../config/types';

// Host из baseUrl (без порта/пути); при ошибке разбора - trim lowercase
export function extractProviderHost(baseUrl: string): string {
	const raw = baseUrl.trim();
	if (!raw) {
		return '';
	}

	try {
		const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
		return new URL(withScheme).hostname.toLowerCase();
	} catch {
		return raw.toLowerCase();
	}
}

// Совпадает ли паттерн с host baseUrl или с model id
export function matchesProviderUsePattern(pattern: string, host: string, modelId: string): boolean {
	const p = pattern.trim().toLowerCase();
	if (!p) {
		return false;
	}

	const hostLc = host.trim().toLowerCase();
	if (hostLc && matchAdminPattern(p, hostLc)) {
		return true;
	}

	const model = modelId.trim().toLowerCase();
	if (model && matchAdminPattern(p, model)) {
		return true;
	}

	return false;
}

/**
 * Проверка политики `provider.use` перед LLM complete().
 * @returns сообщение отказа или undefined если разрешено.
 */
export function providerUseRefusalMessage(
	settings: Pick<HaratsanSettings, 'baseUrl' | 'providerUsePolicy' | 'providerUsePatterns'>,
	modelId: string,
): string | undefined {
	const patterns = settings.providerUsePatterns.map((item) => item.trim()).filter(Boolean);
	if (patterns.length === 0) {
		return undefined;
	}

	const host = extractProviderHost(settings.baseUrl);
	const matched = patterns.find((pat) => matchesProviderUsePattern(pat, host, modelId));
	const subject = modelId.trim() || host || settings.baseUrl.trim() || '?';

	if (settings.providerUsePolicy === 'deny') {
		if (!matched) {
			return undefined;
		}

		return vscode.l10n.t('llm.providerUse.denied', subject, matched);
	}

	// allowlist: нужен хотя бы один match
	if (matched) {
		return undefined;
	}

	return vscode.l10n.t('llm.providerUse.notAllowed', subject);
}

// Бросает Error с локализованным текстом, если провайдер запрещён
export function assertProviderUseAllowed(
	settings: Pick<HaratsanSettings, 'baseUrl' | 'providerUsePolicy' | 'providerUsePatterns'>,
	modelId: string,
): void {
	const message = providerUseRefusalMessage(settings, modelId);
	if (message) {
		throw new Error(message);
	}
}
