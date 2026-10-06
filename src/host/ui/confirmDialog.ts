import * as vscode from 'vscode';
import type { ConfirmChoice } from '../../features/agent/types';
import { focusChatView } from '../../features/chat/focusChat';
import type { ConfirmVariant } from '../../features/chat/protocol';

export interface ConfirmDialogOptions {
	title: string;
	detail?: string;
	// Режим agent: Применить / Пропустить / Стоп; binary: Применить / Отклонить
	variant?: ConfirmVariant;
	applyLabel?: string;
	rejectLabel?: string;
}

export type ConfirmHost = (options: ConfirmDialogOptions) => Promise<ConfirmChoice>;

let host: ConfirmHost | undefined;

// Регистрирует хост подтверждений (карточка в чате)
export function setConfirmHost(next: ConfirmHost | undefined): void {
	host = next;
}

// Единая точка подтверждения: карточка в панели Haratsan (не отдельная вкладка)
export async function showConfirmDialog(options: ConfirmDialogOptions): Promise<ConfirmChoice> {
	if (!host) {
		throw new Error(vscode.l10n.t('ui.confirmHostMissing'));
	}

	await focusChatView().then(undefined, () => undefined);
	return host(options);
}
