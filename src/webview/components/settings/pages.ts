import type { HaratsanSettings } from '../../../core/config/types';

export type SettingsPageId = | 'connection' | 'chat' | 'agent' | 'security' | 'project' | 'journal';

export type SetSettingsField = <K extends keyof HaratsanSettings>(key: K, value: HaratsanSettings[K]) => void;

export interface SettingsPageProps {
	draft: HaratsanSettings;
	setField: SetSettingsField;
}

export const SETTINGS_PAGE_IDS: SettingsPageId[] = ['connection', 'chat', 'agent', 'security', 'project', 'journal'];

export const SETTINGS_PAGE_CODICON: Record<SettingsPageId, string> = {
	connection: 'plug',
	chat: 'comment-discussion',
	agent: 'hubot',
	security: 'shield',
	project: 'folder',
	journal: 'history',
};

export function settingsNavTitleKey(id: SettingsPageId): string {
	return `settings.nav.${id}`;
}
