import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminPolicyInfo, ChatViewState, IndexEngineStatus, PanelScreen, PersonaOption, ToWebviewMessage } from '../features/chat/protocol';
import type { HaratsanSettings } from '../core/config/types';
import { DEFAULT_SETTINGS } from '../core/config/types';
import type { LlmModelOption } from '../core/llm/types';
import type { AgentsPageData } from './components/settings/AgentsPage';
import type { HooksPageData } from './components/settings/HooksPage';
import type { RulesSkillsPageData } from './components/settings/RulesSkillsPage';
import { t } from './i18n';
import { vscodeApi } from './vscodeApi';

const EMPTY_CHAT: ChatViewState = {
	messages: [],
	busy: false,
	queuedCount: 0,
	mode: 'ask',
};

function readInitialScreen(): PanelScreen {
	return document.body.dataset.screen === 'settings' ? 'settings' : 'chat';
}

// Короткий тихий sine-beep через Web Audio API
function playNotifyBeep(): void {
	try {
		const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AudioCtx) {
			return;
		}

		const ctx = new AudioCtx();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'sine';
		osc.frequency.value = 660;
		osc.connect(gain);
		gain.connect(ctx.destination);
		const t0 = ctx.currentTime;
		gain.gain.setValueAtTime(0.0001, t0);
		gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
		osc.start(t0);
		osc.stop(t0 + 0.25);
		osc.onended = () => {
			void ctx.close();
		};
		void ctx.resume();
	} catch {}
}

export function useHaratsanBridge() {
	const [screen] = useState<PanelScreen>(readInitialScreen);
	const [chat, setChat] = useState<ChatViewState>(EMPTY_CHAT);
	const [settings, setSettings] = useState<HaratsanSettings>(DEFAULT_SETTINGS);
	const [personas, setPersonas] = useState<PersonaOption[]>([]);
	const [adminPolicy, setAdminPolicy] = useState<AdminPolicyInfo | undefined>();
	const [apiKeySet, setApiKeySet] = useState(false);
	const [webSearchApiKeySet, setWebSearchApiKeySet] = useState(false);
	const [persistedAlwaysAllow, setPersistedAlwaysAllow] = useState<string[]>([]);
	const [settingsStatus, setSettingsStatus] = useState<string | undefined>();
	const [models, setModels] = useState<LlmModelOption[]>([]);
	const [modelsStatus, setModelsStatus] = useState<string | undefined>();
	const [modelsLoading, setModelsLoading] = useState(false);
	const [connectionHealth, setConnectionHealth] = useState<{
		ok: boolean;
		message: string
	} | undefined>();
	const [connectionHealthLoading, setConnectionHealthLoading] = useState(false);
	const [indexStatus, setIndexStatus] = useState<IndexEngineStatus | undefined>();
	const [hooks, setHooks] = useState<HooksPageData | undefined>();
	const [hooksStatus, setHooksStatus] = useState<string | undefined>();
	const [agents, setAgents] = useState<AgentsPageData | undefined>();
	const [agentsStatus, setAgentsStatus] = useState<string | undefined>();
	const [rulesSkills, setRulesSkills] = useState<RulesSkillsPageData | undefined>();
	const modelsRequestId = useRef(0);
	const connectionHealthRequestId = useRef(0);

	useEffect(() => {
		const onMessage = (event: MessageEvent<ToWebviewMessage>) => {
			const data = event.data;
			if (!data || typeof data !== 'object' || !('type' in data)) {
				return;
			}

			switch (data.type) {
				case 'state':
					setChat(data.state);
					return;
				case 'settings':
					setSettings(data.settings);
					setApiKeySet(data.apiKeySet);
					setWebSearchApiKeySet(Boolean(data.webSearchApiKeySet));
					if (Array.isArray(data.persistedAlwaysAllow)) {
						setPersistedAlwaysAllow(data.persistedAlwaysAllow);
					}

					if (data.personas) {
						setPersonas(data.personas);
					}

					setAdminPolicy(data.adminPolicy);
					return;
				case 'settingsSaved':
					setSettings(data.settings);
					setApiKeySet(data.apiKeySet);
					setWebSearchApiKeySet(Boolean(data.webSearchApiKeySet));
					if (Array.isArray(data.persistedAlwaysAllow)) {
						setPersistedAlwaysAllow(data.persistedAlwaysAllow);
					}
					
					if (data.personas) {
						setPersonas(data.personas);
					}

					setAdminPolicy(data.adminPolicy);
					setSettingsStatus(t('settings.status.saved'));
					return;
				case 'settingsError':
					setSettingsStatus(data.message);
					return;
				case 'models':
					if (data.requestId !== modelsRequestId.current) {
						return;
					}
					setModels(data.models);
					setModelsLoading(false);
					setModelsStatus(
						data.models.length === 0
							? t('settings.models.empty')
							: t('settings.models.loaded', data.models.length),
					);
					if (data.models.length > 0) {
						setSettings((prev) => {
							if (prev.model && data.models.some((item) => item.id === prev.model)) {
								return prev;
							}

							return {
								...prev,
								model: data.models[0].id,
							};
						});
					}
					return;
				case 'modelsError':
					if (data.requestId !== modelsRequestId.current) {
						return;
					}
					setModelsLoading(false);
					setModelsStatus(data.message);
					return;
				case 'connectionHealth':
					if (data.requestId !== connectionHealthRequestId.current) {
						return;
					}
					setConnectionHealthLoading(false);
					setConnectionHealth({
						ok: data.ok,
						message: data.message
					});
					return;
				case 'indexStatus':
					setIndexStatus(data.status);
					return;
				case 'hooksData':
					setHooks({
						beforeSubmit: data.beforeSubmit,
						beforeShell: data.beforeShell,
						sessionDiff: data.sessionDiff,
						sessionCompacting: data.sessionCompacting,
						shellEnv: data.shellEnv ?? [],
						fileWatcher: data.fileWatcher ?? [],
						path: data.path,
						error: data.error,
					});
					return;
				case 'hooksSaved':
					if (data.ok) {
						setHooksStatus(t('settings.hooks.saved'));
					} else {
						setHooksStatus(data.error || t('settings.hooks.saveFailed'));
					}
					return;
				case 'agentsData':
					setAgents({
						presets: data.presets,
						custom: data.custom,
						error: data.error,
					});
					return;
				case 'agentsCloned':
					if (data.error) {
						setAgentsStatus(data.error);
					} else if (data.created) {
						setAgentsStatus(t('settings.agents.cloned', data.relativePath));
					} else {
						setAgentsStatus(t('settings.agents.updated', data.relativePath));
					}
					return;
				case 'rulesSkillsData':
					setRulesSkills({
						rules: data.rules,
						skills: data.skills,
						plugins: data.plugins ?? [],
					});
					return;
				case 'personasData':
					setPersonas(data.personas);
					return;
				case 'playNotifySound':
					playNotifyBeep();
					return;
			}
		};

		window.addEventListener('message', onMessage);
		vscodeApi.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	const saveSettings = useCallback((next: HaratsanSettings, api?: {
		apiKey?: string;
		clearApiKey?: boolean;
		webSearchApiKey?: string;
		clearWebSearchApiKey?: boolean;
		persistedAlwaysAllow?: string[];
	}) => {
		setSettingsStatus(t('settings.status.saving'));
		vscodeApi.postMessage({
			type: 'saveSettings',
			settings: { ...next, webSearchApiKey: '' },
			apiKey: api?.apiKey,
			clearApiKey: api?.clearApiKey,
			webSearchApiKey: api?.webSearchApiKey,
			clearWebSearchApiKey: api?.clearWebSearchApiKey,
			persistedAlwaysAllow: api?.persistedAlwaysAllow,
		});
	}, []);

	const loadModels = useCallback((baseUrl: string) => {
		const trimmed = baseUrl.trim();
		if (!trimmed) {
			setModels([]);
			setModelsLoading(false);
			setModelsStatus(t('settings.models.needUrl'));
			return;
		}

		const requestId = modelsRequestId.current + 1;
		modelsRequestId.current = requestId;
		setModelsLoading(true);
		setSettingsStatus(undefined);
		setModelsStatus(t('settings.models.loading'));
		vscodeApi.postMessage({
			type: 'loadModels',
			baseUrl: trimmed,
			requestId,
		});
	}, []);

	const checkConnection = useCallback((baseUrl: string) => {
		const trimmed = baseUrl.trim();
		if (!trimmed) {
			setConnectionHealth({ 
				ok: false, 
				message: t('settings.models.needUrl')
			});
			return;
		}

		const requestId = connectionHealthRequestId.current + 1;
		connectionHealthRequestId.current = requestId;
		setConnectionHealthLoading(true);
		setConnectionHealth(undefined);
		vscodeApi.postMessage({
			type: 'checkConnection',
			baseUrl: trimmed,
			requestId,
		});
	}, []);

	const openLogsFolder = useCallback(() => {
		vscodeApi.postMessage({ type: 'openLogsFolder' });
	}, []);

	const loadIndexStatus = useCallback(() => {
		vscodeApi.postMessage({ type: 'loadIndexStatus' });
	}, []);

	const cancelIndex = useCallback(() => {
		vscodeApi.postMessage({ type: 'cancelIndex' });
	}, []);

	const repairIndex = useCallback(() => {
		vscodeApi.postMessage({ type: 'repairIndex' });
	}, []);

	const loadHooks = useCallback(() => {
		setHooksStatus(undefined);
		vscodeApi.postMessage({ type: 'loadHooks' });
	}, []);

	const saveHooks = useCallback((payload: {
		beforeSubmit: string[];
		beforeShell: string[];
		sessionDiff: string[];
		sessionCompacting: string[];
		shellEnv: string[];
		fileWatcher: string[];
	}) => {
		setHooksStatus(t('settings.hooks.saving'));
		vscodeApi.postMessage({
			type: 'saveHooks',
			beforeSubmit: payload.beforeSubmit,
			beforeShell: payload.beforeShell,
			sessionDiff: payload.sessionDiff,
			sessionCompacting: payload.sessionCompacting,
			shellEnv: payload.shellEnv,
			fileWatcher: payload.fileWatcher,
		});
	}, []);

	const openHooksFile = useCallback(() => {
		vscodeApi.postMessage({ type: 'openHooksFile' });
	}, []);

	const loadAgents = useCallback(() => {
		setAgentsStatus(undefined);
		vscodeApi.postMessage({ type: 'loadAgents' });
	}, []);

	const cloneAgentPreset = useCallback((id: string) => {
		setAgentsStatus(t('settings.agents.cloning'));
		vscodeApi.postMessage({ type: 'cloneAgentPreset', id });
	}, []);

	const loadRulesSkills = useCallback(() => {
		vscodeApi.postMessage({ type: 'loadRulesSkills' });
	}, []);

	const loadPersonas = useCallback(() => {
		vscodeApi.postMessage({ type: 'loadPersonas' });
	}, []);

	const openProjectPath = useCallback((path: string) => {
		vscodeApi.postMessage({ type: 'openProjectPath', path });
	}, []);

	return {
		screen,
		chat,
		settings,
		personas,
		adminPolicy,
		apiKeySet,
		webSearchApiKeySet,
		persistedAlwaysAllow,
		settingsStatus,
		models,
		modelsStatus,
		modelsLoading,
		connectionHealth,
		connectionHealthLoading,
		indexStatus,
		hooks,
		hooksStatus,
		agents,
		agentsStatus,
		rulesSkills,
		saveSettings,
		loadModels,
		checkConnection,
		openLogsFolder,
		loadIndexStatus,
		cancelIndex,
		repairIndex,
		loadHooks,
		saveHooks,
		openHooksFile,
		loadAgents,
		cloneAgentPreset,
		loadRulesSkills,
		loadPersonas,
		openProjectPath,
	};
}
