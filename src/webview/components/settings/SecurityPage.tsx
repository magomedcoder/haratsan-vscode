import type { SettingsPageProps } from './pages';
import { FieldToggle } from './SettingsFields';
import { SettingsSection } from './SettingsSection';

export function SecurityPage({ draft, setField }: SettingsPageProps) {
	return (
		<SettingsSection titleKey="settings.section.security.basics" hintKey="settings.section.security.basicsHint">
			<FieldToggle
				labelKey="settings.autoApprove.label"
				hintKey="settings.autoApprove.hint"
				checked={draft.autoApprove}
				onChange={(v) => setField('autoApprove', v)}
			/>
			<FieldToggle
				labelKey="settings.continueLoopOnDeny.label"
				hintKey="settings.continueLoopOnDeny.hint"
				checked={draft.continueLoopOnDeny}
				onChange={(v) => setField('continueLoopOnDeny', v)}
			/>
			<FieldToggle
				labelKey="settings.enableFileReading.label"
				checked={draft.enableFileReading}
				onChange={(v) => setField('enableFileReading', v)}
			/>
			<FieldToggle
				labelKey="settings.enableTerminal.label"
				checked={draft.enableTerminal}
				onChange={(v) => setField('enableTerminal', v)}
			/>
			<FieldToggle
				labelKey="settings.webSearchEnabled.label"
				checked={draft.webSearchEnabled}
				onChange={(v) => setField('webSearchEnabled', v)}
			/>
			<FieldToggle
				labelKey="settings.webFetchEnabled.label"
				checked={draft.webFetchEnabled}
				onChange={(v) => setField('webFetchEnabled', v)}
			/>
			<FieldToggle
				labelKey="settings.enableWorkspaceContext.label"
				checked={draft.enableWorkspaceContext}
				onChange={(v) => setField('enableWorkspaceContext', v)}
			/>
			<FieldToggle
				labelKey="settings.allowExternalDirectory.label"
				hintKey="settings.allowExternalDirectory.hint"
				checked={draft.allowExternalDirectory}
				onChange={(v) => setField('allowExternalDirectory', v)}
			/>
		</SettingsSection>
	);
}
