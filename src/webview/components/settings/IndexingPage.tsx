import { useEffect } from 'react';
import type { IndexEngineStatus } from '../../../features/chat/protocol';
import { t } from '../../i18n';
import type { SettingsPageProps } from './pages';
import { FieldSelect, FieldText, FieldTextarea, FieldToggle } from './SettingsFields';
import { SettingsSection } from './SettingsSection';

interface IndexingPageProps extends SettingsPageProps {
	indexStatus?: IndexEngineStatus;
	onLoadIndexStatus?: () => void;
	onCancelIndex?: () => void;
	onRepairIndex?: () => void;
}

function formatIndexUpdatedAt(iso?: string): string | undefined {
	if (!iso) {
		return undefined;
	}
	const ms = new Date(iso).getTime();
	if (!Number.isFinite(ms) || ms <= 0) {
		return undefined;
	}
	try {
		return new Date(ms).toLocaleString();
	} catch {
		return iso;
	}
}

function indexEngineModeLabel(mode: IndexEngineStatus['mode']): string {
	switch (mode) {
		case 'remote':
			return t('settings.indexEngine.remote');
		case 'local-vector':
			return t('settings.indexEngine.localVector');
		case 'cpu-trigram':
		default:
			return t('settings.indexEngine.cpuTrigram');
	}
}

function buildIndexEngineLine(status: IndexEngineStatus): string {
	const parts = [indexEngineModeLabel(status.mode)];

	if (!status.indexingEnabled) {
		parts.push(t('settings.indexEngine.disabled'));
	} else if (status.progressState === 'indexing') {
		parts.push(t('settings.indexEngine.indexing'));
	} else if (status.progressState === 'cancelled') {
		parts.push(t('settings.indexEngine.cancelled'));
	} else if (status.progressState === 'error' || status.corrupt) {
		parts.push(t('settings.indexEngine.error'));
	}

	if (typeof status.fileCount === 'number' && status.fileCount > 0) {
		parts.push(t('settings.indexEngine.files', status.fileCount));
	}

	const updated = formatIndexUpdatedAt(status.updatedAt);
	if (updated) {
		parts.push(t('settings.indexEngine.updated', updated));
	}

	return `${t('settings.indexEngine.label')}: ${parts.toString()}`;
}

function showRepairButton(status: IndexEngineStatus): boolean {
	if (!status.indexingEnabled) {
		return false;
	}
	
	if (status.progressState === 'indexing') {
		return false;
	}

	return (
		status.progressState === 'error' ||
		status.progressState === 'cancelled' ||
		Boolean(status.corrupt) ||
		Boolean(status.missingDirDigests) ||
		Boolean(status.partialErrors?.length) ||
		Boolean(status.lastError)
	);
}

export function IndexingPage({
	draft,
	setField,
	indexStatus,
	onLoadIndexStatus,
	onCancelIndex,
	onRepairIndex,
}: IndexingPageProps) {
	useEffect(() => {
		onLoadIndexStatus?.();
	}, [onLoadIndexStatus]);

	return (
		<SettingsSection titleKey="settings.section.indexing" hintKey="settings.section.indexingHint">
			{indexStatus ? (
				<div className="field field-status" role="status">
					<span className="field__label">{buildIndexEngineLine(indexStatus)}</span>
					<span className="field__hint">{t('settings.indexEngine.hint')}</span>
					{indexStatus.lastError ? (
						<span className="field__hint field__hint--error">{indexStatus.lastError}</span>
					) : null}
					{indexStatus.partialErrors && indexStatus.partialErrors.length > 0 ? (
						<span className="field__hint field__hint--error">
							{indexStatus.partialErrors.slice(0, 5).join('\n')}
							{indexStatus.partialErrors.length > 5
								? `\n...+${indexStatus.partialErrors.length - 5}`
								: ''}
						</span>
					) : null}
					<div className="field__actions" style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
						{indexStatus.progressState === 'indexing' ? (
							<button
								className="btn btn--secondary"
								type="button"
								onClick={() => onCancelIndex?.()}
							>
								{t('settings.indexEngine.cancel')}
							</button>
						) : null}
						{showRepairButton(indexStatus) ? (
							<button
								className="btn btn--secondary"
								type="button"
								onClick={() => onRepairIndex?.()}
							>
								{t('settings.indexEngine.repair')}
							</button>
						) : null}
					</div>
				</div>
			) : null}

			<FieldToggle
				labelKey="settings.indexingEnabled.label"
				hintKey="settings.indexingEnabled.hint"
				checked={draft.indexingEnabled}
				onChange={(v) => setField('indexingEnabled', v)}
			/>
			<FieldToggle
				labelKey="settings.indexNewFolders.label"
				hintKey="settings.indexNewFolders.hint"
				checked={draft.indexNewFolders}
				onChange={(v) => setField('indexNewFolders', v)}
			/>
			<FieldToggle
				labelKey="settings.indexForGrep.label"
				hintKey="settings.indexForGrep.hint"
				checked={draft.indexForGrep}
				onChange={(v) => setField('indexForGrep', v)}
			/>
			<FieldSelect
				labelKey="settings.localEmbeddingsMode.label"
				hintKey="settings.localEmbeddingsMode.hint"
				value={draft.localEmbeddingsMode}
				onChange={(v) =>
					setField('localEmbeddingsMode', v as typeof draft.localEmbeddingsMode)
				}
			>
				<option value="off">{t('settings.localEmbeddingsMode.off')}</option>
				<option value="trigram">{t('settings.localEmbeddingsMode.trigram')}</option>
				<option value="vector">{t('settings.localEmbeddingsMode.vector')}</option>
			</FieldSelect>
			<FieldText
				labelKey="settings.embeddingsBaseUrl.label"
				hintKey="settings.embeddingsBaseUrl.hint"
				value={draft.embeddingsBaseUrl}
				onChange={(v) => setField('embeddingsBaseUrl', v)}
			/>
			<FieldText
				labelKey="settings.embeddingsModel.label"
				hintKey="settings.embeddingsModel.hint"
				value={draft.embeddingsModel}
				onChange={(v) => setField('embeddingsModel', v)}
			/>
			<FieldTextarea
				labelKey="settings.watcherIgnore.label"
				hintKey="settings.watcherIgnore.hint"
				code
				rows={3}
				value={draft.watcherIgnore.join('\n')}
				onChange={(v) => setField('watcherIgnore', v.split(/\r?\n/))}
			/>
		</SettingsSection>
	);
}
