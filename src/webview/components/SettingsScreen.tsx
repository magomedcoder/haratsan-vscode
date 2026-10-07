import { useEffect, useMemo, useState, type ReactNode, type SubmitEvent } from 'react';
import type { AdminPolicyInfo, IndexEngineStatus, PersonaOption, ResearchJobUi } from '../../features/chat/protocol';
import type { HaratsanSettings } from '../../core/config/types';
import { DEFAULT_SETTINGS } from '../../core/config/types';
import type { LlmModelOption } from '../../core/llm/types';
import { t } from '../i18n';
import { ChatPage } from './settings/ChatPage';
import { ConnectionPage } from './settings/ConnectionPage';
import { HooksPage, type HooksPageData } from './settings/HooksPage';
import { IndexingPage } from './settings/IndexingPage';
import { LoggingPage } from './settings/LoggingPage';
import { SETTINGS_PAGE_CODICON, SETTINGS_PAGE_IDS, settingsNavTitleKey } from './settings/pages';
import type { SettingsPageId } from './settings/pages';
import { PermissionsPage } from './settings/PermissionsPage';
import { PersonasPage } from './settings/PersonasPage';
import { RequestPage } from './settings/RequestPage';
import { RulesSkillsPage, type RulesSkillsPageData } from './settings/RulesSkillsPage';
import { SecurityPage } from './settings/SecurityPage';
import { UsagePage } from './settings/UsagePage';
import { ActivityPage } from './settings/ActivityPage';
import { AgentBehaviorPage } from './settings/AgentBehaviorPage';
import { AgentsPage, type AgentsPageData } from './settings/AgentsPage';
interface SettingsScreenProps {
	settings: HaratsanSettings;
	personas?: PersonaOption[];
	// Admin policy: locked keys баннер
	adminPolicy?: AdminPolicyInfo;
	status?: string;
	apiKeySet: boolean;
	webSearchApiKeySet?: boolean;
	persistedAlwaysAllow?: string[];
	models: LlmModelOption[];
	modelsStatus?: string;
	modelsLoading: boolean;
	connectionHealth?: { 
		ok: boolean;
		message: string
	};
	connectionHealthLoading?: boolean;
	indexStatus?: IndexEngineStatus;
	hooks?: HooksPageData;
	hooksStatus?: string;
	agents?: AgentsPageData;
	agentsStatus?: string;
	rulesSkills?: RulesSkillsPageData;
	onSave: (settings: HaratsanSettings, api?: {
		apiKey?: string;
		clearApiKey?: boolean;
		webSearchApiKey?: string;
		clearWebSearchApiKey?: boolean;
		persistedAlwaysAllow?: string[];
	}) => void;
	onLoadModels: (baseUrl: string) => void;
	onCheckConnection?: (baseUrl: string) => void;
	onOpenLogsFolder: () => void;
	onLoadIndexStatus?: () => void;
	onCancelIndex?: () => void;
	onRepairIndex?: () => void;
	onLoadHooks?: () => void;
	onSaveHooks?: (payload: {
		beforeSubmit: string[];
		beforeShell: string[];
		sessionDiff: string[];
		sessionCompacting: string[];
		shellEnv: string[];
		fileWatcher: string[];
	}) => void;
	onOpenHooksFile?: () => void;
	onLoadAgents?: () => void;
	onCloneAgentPreset?: (id: string) => void;
	onLoadRulesSkills?: () => void;
	onLoadPersonas?: () => void;
	onOpenProjectPath?: (path: string) => void;
	// Known server n_ctx for maxContextTokens warn
	cachedNCtx?: number;
	// Live research jobs (Teams) - из chat state, если Settings в том же webview
	researchJobs?: ResearchJobUi[];
}

function renderNavItems(
	pages: SettingsPageId[],
	active: SettingsPageId,
	onSelect: (id: SettingsPageId) => void,
): ReactNode {
	return pages.map((id) => (
		<button
			key={id}
			type="button"
			className={`settings-nav__item${id === active ? ' settings-nav__item--active' : ''}`}
			onClick={() => onSelect(id)}
		>
			<span
				className={`codicon codicon-${SETTINGS_PAGE_CODICON[id]} settings-nav__icon`}
				aria-hidden="true"
			/>
			<span className="settings-nav__title">{t(settingsNavTitleKey(id))}</span>
		</button>
	));
}

export function SettingsScreen({
	settings,
	personas = [],
	adminPolicy,
	apiKeySet,
	webSearchApiKeySet = false,
	persistedAlwaysAllow: persistedAlwaysAllowProp = [],
	status,
	models,
	modelsStatus,
	modelsLoading,
	connectionHealth,
	connectionHealthLoading = false,
	indexStatus,
	hooks,
	hooksStatus,
	agents,
	agentsStatus,
	rulesSkills,
	onSave,
	onLoadModels,
	onCheckConnection,
	onOpenLogsFolder,
	onLoadIndexStatus,
	onCancelIndex,
	onRepairIndex,
	onLoadHooks,
	onSaveHooks,
	onOpenHooksFile,
	onLoadAgents,
	onCloneAgentPreset,
	onLoadRulesSkills,
	onLoadPersonas,
	onOpenProjectPath,
	cachedNCtx,
	researchJobs,
}: SettingsScreenProps) {
	const [page, setPage] = useState<SettingsPageId>('connection');
	const [draft, setDraft] = useState<HaratsanSettings>(settings);
	const [apiKeyDraft, setApiKeyDraft] = useState('');
	const [clearApiKey, setClearApiKey] = useState(false);
	const [webSearchApiKeyDraft, setWebSearchApiKeyDraft] = useState('');
	const [clearWebSearchApiKey, setClearWebSearchApiKey] = useState(false);
	const [persistedAlwaysAllowDraft, setPersistedAlwaysAllowDraft] = useState<string[]>(persistedAlwaysAllowProp);

	const lockedKeySet = useMemo(
		() => new Set(adminPolicy?.active ? adminPolicy.lockedKeys : []),
		[adminPolicy],
	);

	useEffect(() => {
		setDraft({ ...settings, webSearchApiKey: '' });
		setApiKeyDraft('');
		setClearApiKey(false);
		setWebSearchApiKeyDraft('');
		setClearWebSearchApiKey(false);
		setPersistedAlwaysAllowDraft(persistedAlwaysAllowProp);
		if (settings.baseUrl.trim()) {
			onLoadModels(settings.baseUrl);
		} else {
			onLoadModels('');
		}
	}, [settings, apiKeySet, webSearchApiKeySet, persistedAlwaysAllowProp, onLoadModels]);

	useEffect(() => {
		if (models.length === 0) {
			return;
		}
		setDraft((prev) => {
			if (!prev.baseUrl.trim() || prev.model.trim()) {
				return prev;
			}

			return {
				...prev,
				model: models[0].id,
			};
		});
	}, [models]);

	const setField = <K extends keyof HaratsanSettings>(key: K, value: HaratsanSettings[K]) => {
		// Locked admin keys - только чтение
		if (lockedKeySet.has(key)) {
			return;
		}
		setDraft((prev) => ({ ...prev, [key]: value }));
	};

	const onReset = () => {
		const next: HaratsanSettings = { ...DEFAULT_SETTINGS };
		// Admin-forced значения остаются из effective settings
		for (const key of lockedKeySet) {
			if (key in settings) {
				(next as unknown as Record<string, unknown>)[key] = settings[key as keyof HaratsanSettings];
			}
		}
		// Команды/redact - не из UI; сохраняем effective (project/user/default)
		next.sensitivePathPatterns = [...settings.sensitivePathPatterns];
		next.deniedCommands = [...settings.deniedCommands];
		next.secretPatterns = [...settings.secretPatterns];
		
		setDraft(next);
		setApiKeyDraft('');
		setClearApiKey(false);
		setWebSearchApiKeyDraft('');
		setClearWebSearchApiKey(false);
		onSave(next);
	};

	const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		onSave({ ...draft, webSearchApiKey: '' }, {
			apiKey: clearApiKey ? undefined : apiKeyDraft,
			clearApiKey: clearApiKey || undefined,
			webSearchApiKey: clearWebSearchApiKey ? undefined : webSearchApiKeyDraft,
			clearWebSearchApiKey: clearWebSearchApiKey || undefined,
			persistedAlwaysAllow: persistedAlwaysAllowDraft,
		});
	};

	const currentTitle = t(settingsNavTitleKey(page));
	const showAdminBanner = Boolean(adminPolicy?.active && adminPolicy.lockedKeys.length > 0);

	return (
		<div className="app">
			<header className="header">
				<div className="header__left">
					<span className="header__title">{t('settings.title')}</span>
					<span className="header__subtitle">{currentTitle}</span>
				</div>
				<button className="btn btn--secondary" type="button" onClick={onReset}>{t('settings.reset')}</button>
			</header>

			{showAdminBanner ? (
				<div className="project-banner project-banner--policy" role="status">
					<div className="project-banner__text">
						<strong className="project-banner__title">{t('settings.adminPolicy.title')}</strong>
						<span className="project-banner__hint">
							{t('settings.adminPolicy.hint', adminPolicy!.lockedKeys.join(', '))}
						</span>
						{adminPolicy?.path ? (
							<span className="project-banner__hint project-banner__hint--mono">{adminPolicy.path}</span>
						) : null}
					</div>
				</div>
			) : null}

			<form className="settings-layout" onSubmit={onSubmit}>
				<nav className="settings-nav" aria-label={t('settings.navAria')}>
					{renderNavItems(SETTINGS_PAGE_IDS, page, setPage)}
				</nav>

				<div className="settings-main">
					<div className="settings">
						{page === 'connection' ? (
							<>
								<ConnectionPage
									draft={draft}
									setField={setField}
									apiKeySet={apiKeySet}
									apiKeyDraft={apiKeyDraft}
									clearApiKey={clearApiKey}
									models={models}
									modelsStatus={modelsStatus}
									modelsLoading={modelsLoading}
									connectionHealth={connectionHealth}
									connectionHealthLoading={connectionHealthLoading}
									onApiKeyDraft={(v) => {
										setClearApiKey(false);
										setApiKeyDraft(v);
									}}
									onClearApiKey={() => {
										setClearApiKey(true);
										setApiKeyDraft('');
									}}
									onLoadModels={onLoadModels}
									onCheckConnection={onCheckConnection}
								/>
								<RequestPage
									draft={draft}
									setField={setField}
									cachedNCtx={cachedNCtx}
									webSearchApiKeySet={webSearchApiKeySet}
									webSearchApiKeyDraft={webSearchApiKeyDraft}
									clearWebSearchApiKey={clearWebSearchApiKey}
									onWebSearchApiKeyDraft={(v) => {
										setClearWebSearchApiKey(false);
										setWebSearchApiKeyDraft(v);
									}}
									onClearWebSearchApiKey={() => {
										setClearWebSearchApiKey(true);
										setWebSearchApiKeyDraft('');
									}}
								/>
							</>
						) : null}
						{page === 'chat' ? (
							<ChatPage
								draft={draft}
								setField={setField}
								personas={personas}
								onOpenPersonasPage={() => setPage('project')}
							/>
						) : null}
						{page === 'agent' ? (
							<AgentBehaviorPage draft={draft} setField={setField} />
						) : null}
						{page === 'security' ? (
							<>
								<SecurityPage draft={draft} setField={setField} />
								<PermissionsPage
									draft={draft}
									setField={setField}
									persistedAlwaysAllow={persistedAlwaysAllowDraft}
									onPersistedAlwaysAllowChange={setPersistedAlwaysAllowDraft}
								/>
							</>
						) : null}
						{page === 'project' ? (
							<>
								<IndexingPage
									draft={draft}
									setField={setField}
									indexStatus={indexStatus}
									onLoadIndexStatus={onLoadIndexStatus}
									onCancelIndex={onCancelIndex}
									onRepairIndex={onRepairIndex}
								/>
								<RulesSkillsPage
									data={rulesSkills}
									onLoad={onLoadRulesSkills}
									onOpenPath={onOpenProjectPath}
								/>
								<PersonasPage
									draft={draft}
									setField={setField}
									personas={personas}
									onLoadPersonas={onLoadPersonas}
									onOpenPath={onOpenProjectPath}
								/>
								<AgentsPage
									agents={agents}
									agentsStatus={agentsStatus}
									onLoadAgents={onLoadAgents}
									onCloneAgentPreset={onCloneAgentPreset}
									researchJobs={researchJobs}
								/>
								<HooksPage
									hooks={hooks}
									hooksStatus={hooksStatus}
									onLoadHooks={onLoadHooks}
									onSaveHooks={onSaveHooks}
									onOpenHooksFile={onOpenHooksFile}
								/>
							</>
						) : null}
						{page === 'journal' ? (
							<>
								<UsagePage draft={draft} setField={setField} />
								<ActivityPage draft={draft} setField={setField} />
								<LoggingPage
									draft={draft}
									setField={setField}
									onOpenLogsFolder={onOpenLogsFolder}
								/>
							</>
						) : null}
					</div>

					<div className="settings-footer">
						{status ? <div className="settings__status">{status}</div> : null}
						<button className="btn" type="submit">{t('settings.save')}</button>
					</div>
				</div>
			</form>
		</div>
	);
}
