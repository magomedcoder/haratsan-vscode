import * as vscode from 'vscode';
import type { ExtensionContext, SecretStorage } from 'vscode';

export type HaratsanSecretId = 'apiKey' | 'webSearchApiKey';

const SECRET_KEYS: Record<HaratsanSecretId, string> = {
	apiKey: 'haratsan.apiKey',
	webSearchApiKey: 'haratsan.webSearchApiKey',
};

let secrets: SecretStorage | undefined;

export function initSecretVault(context: ExtensionContext): void {
	secrets = context.secrets;
}

function requireSecrets(): SecretStorage {
	if (!secrets) {
		throw new Error(vscode.l10n.t('config.apiKeyNotInit'));
	}
	return secrets;
}

export async function getSecret(id: HaratsanSecretId): Promise<string> {
	return (await requireSecrets().get(SECRET_KEYS[id]))?.trim() ?? '';
}

export async function hasSecret(id: HaratsanSecretId): Promise<boolean> {
	return Boolean(await getSecret(id));
}

export async function setSecret(id: HaratsanSecretId, value: string): Promise<void> {
	const store = requireSecrets();
	const trimmed = value.trim();
	if (!trimmed) {
		await store.delete(SECRET_KEYS[id]);
		return;
	}

	await store.store(SECRET_KEYS[id], trimmed);
}

export async function clearSecret(id: HaratsanSecretId): Promise<void> {
	await setSecret(id, '');
}
