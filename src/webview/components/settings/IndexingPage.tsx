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
	} else if (status.progressState === 'error' || status.corrupt || status.merkleMismatch) {
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

function buildIndexExtrasLine(status: IndexEngineStatus): string | undefined {
	const bits: string[] = [];
	if (status.treeSitterAvailable) {
		const n = status.treeSitterGrammars?.length ?? 0;
		bits.push(t('settings.indexEngine.treesitterOn', n));
	} else {
		bits.push(t('settings.indexEngine.treesitterOff'));
	}

	if (typeof status.astChunkRatio === 'number') {
		bits.push(t('settings.indexEngine.astRatio', Math.round(status.astChunkRatio * 100)));
	}

	if (typeof status.merkleSkipPct === 'number') {
		bits.push(t('settings.indexEngine.merkleSkip', status.merkleSkipPct));
	}

	if (status.outlineBySource && Object.keys(status.outlineBySource).length > 0) {
		const parts = Object.entries(status.outlineBySource).map(([k, v]) => `${k}:${v}`).join(' ');
		bits.push(t('settings.indexEngine.outlineSources', parts));
	}

	if (status.indexStorageBackend) {
		bits.push(t('settings.indexEngine.storage', status.indexStorageBackend + (status.sqliteAvailable ? '' : ' (нет node:sqlite)')));
	}
	
	return bits.length ? bits.toString() : undefined;
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
		Boolean(status.merkleMismatch) ||
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
					{buildIndexExtrasLine(indexStatus) ? (
						<span className="field__hint">{buildIndexExtrasLine(indexStatus)}</span>
					) : null}
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
			<FieldSelect
				labelKey="settings.outlineEngine.label"
				hintKey="settings.outlineEngine.hint"
				value={draft.outlineEngine}
				onChange={(v) => setField('outlineEngine', v as typeof draft.outlineEngine)}
			>
				<option value="auto">{t('settings.outlineEngine.auto')}</option>
				<option value="treesitter">{t('settings.outlineEngine.treesitter')}</option>
				<option value="lsp">{t('settings.outlineEngine.lsp')}</option>
				<option value="typescript">{t('settings.outlineEngine.typescript')}</option>
			</FieldSelect>
			<FieldSelect
				labelKey="settings.chunkEngine.label"
				hintKey="settings.chunkEngine.hint"
				value={draft.chunkEngine}
				onChange={(v) => setField('chunkEngine', v as typeof draft.chunkEngine)}
			>
				<option value="auto">{t('settings.chunkEngine.auto')}</option>
				<option value="treesitter">{t('settings.chunkEngine.treesitter')}</option>
				<option value="lines">{t('settings.chunkEngine.lines')}</option>
			</FieldSelect>
			<FieldTextarea
				labelKey="settings.treeSitterLanguages.label"
				hintKey="settings.treeSitterLanguages.hint"
				code
				rows={2}
				value={draft.treeSitterLanguages.join('\n')}
				onChange={(v) => setField('treeSitterLanguages', v.split(/\r?\n/))}
			/>
			<FieldSelect
				labelKey="settings.treeSitterUseWorker.label"
				hintKey="settings.treeSitterUseWorker.hint"
				value={draft.treeSitterUseWorker ? 'on' : 'off'}
				onChange={(v) => setField('treeSitterUseWorker', v === 'on')}
			>
				<option value="off">{t('settings.treeSitterUseWorker.off')}</option>
				<option value="on">{t('settings.treeSitterUseWorker.on')}</option>
			</FieldSelect>
			<FieldToggle
				labelKey="settings.indexForceContentHash.label"
				hintKey="settings.indexForceContentHash.hint"
				checked={draft.indexForceContentHash}
				onChange={(v) => setField('indexForceContentHash', v)}
			/>
			<FieldSelect
				labelKey="settings.indexStorageBackend.label"
				hintKey="settings.indexStorageBackend.hint"
				value={draft.indexStorageBackend}
				onChange={(v) => setField('indexStorageBackend', v as typeof draft.indexStorageBackend)}
			>
				<option value="json">{t('settings.indexStorageBackend.json')}</option>
				<option value="sqlite">{t('settings.indexStorageBackend.sqlite')}</option>
			</FieldSelect>
			<FieldText
				labelKey="settings.indexSqliteMinFiles.label"
				hintKey="settings.indexSqliteMinFiles.hint"
				value={String(draft.indexSqliteMinFiles)}
				onChange={(v) => setField('indexSqliteMinFiles', Math.max(0, Number(v) || 0))}
			/>
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
