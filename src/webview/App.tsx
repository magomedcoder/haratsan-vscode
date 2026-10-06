import { useCallback, useState } from 'react';
import type { ThinkingDisplay } from '../core/config/types';
import { ChatHeader } from './components/ChatHeader';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { ProjectSetupBanner } from './components/ProjectSetupBanner';
import { ResearchJobsPanel } from './components/ResearchJobsPanel';
import { SettingsScreen } from './components/SettingsScreen';
import { TodoPanel } from './components/TodoPanel';
import { t } from './i18n';
import { useHaratsanBridge } from './useHaratsanBridge';
import { vscodeApi } from './vscodeApi';

const TOOL_DETAILS_STORAGE_KEY = 'haratsan.toolDetailsExpanded';
const THINKING_DISPLAY_STORAGE_KEY = 'haratsan.thinkingDisplay';

function readToolDetailsExpanded(): boolean {
	try {
		const raw = localStorage.getItem(TOOL_DETAILS_STORAGE_KEY);
		if (raw === null) {
			return true;
		}
		return raw === '1' || raw === 'true';
	} catch {
		return true;
	}
}

function writeToolDetailsExpanded(expanded: boolean): void {
	try {
		localStorage.setItem(TOOL_DETAILS_STORAGE_KEY, expanded ? '1' : '0');
	} catch {}
}

function normalizeThinkingDisplay(raw: unknown): ThinkingDisplay {
	const value = String(raw ?? '');
	if (value === 'off' || value === 'expanded') {
		return value;
	}

	return 'collapsed';
}

function readThinkingDisplay(fallback: ThinkingDisplay): ThinkingDisplay {
	try {
		const raw = localStorage.getItem(THINKING_DISPLAY_STORAGE_KEY);
		if (raw === null) {
			return fallback;
		}
		return normalizeThinkingDisplay(raw);
	} catch {
		return fallback;
	}
}

function writeThinkingDisplay(mode: ThinkingDisplay): void {
	try {
		localStorage.setItem(THINKING_DISPLAY_STORAGE_KEY, mode);
	} catch {}
}

export function App() {
	const {
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
	} = useHaratsanBridge();

	const [toolDetailsExpanded, setToolDetailsExpanded] = useState(readToolDetailsExpanded);
	const setToolDetailsExpandedPersist = useCallback((expanded: boolean) => {
		writeToolDetailsExpanded(expanded);
		setToolDetailsExpanded(expanded);
	}, []);

	const [thinkingDisplay, setThinkingDisplay] = useState<ThinkingDisplay>(() =>
		readThinkingDisplay(normalizeThinkingDisplay(settings.thinkingDisplay)));
	const setThinkingDisplayPersist = useCallback((mode: ThinkingDisplay) => {
		writeThinkingDisplay(mode);
		setThinkingDisplay(mode);
	}, []);

	// Подгрузить модели для компактного picker в шапке чата
	const handleLoadChatModels = useCallback(() => {
		const baseUrl = settings.baseUrl.trim();
		if (baseUrl) {
			loadModels(baseUrl);
		}
	}, [settings.baseUrl, loadModels]);

	if (screen === 'settings') {
		return (
			<SettingsScreen
				settings={settings}
				personas={personas}
				adminPolicy={adminPolicy}
				apiKeySet={apiKeySet}
				webSearchApiKeySet={webSearchApiKeySet}
				persistedAlwaysAllow={persistedAlwaysAllow}
				status={settingsStatus}
				models={models}
				modelsStatus={modelsStatus}
				modelsLoading={modelsLoading}
				connectionHealth={connectionHealth}
				connectionHealthLoading={connectionHealthLoading}
				indexStatus={indexStatus}
				hooks={hooks}
				hooksStatus={hooksStatus}
				agents={agents}
				agentsStatus={agentsStatus}
				rulesSkills={rulesSkills}
				onSave={saveSettings}
				onLoadModels={loadModels}
				onCheckConnection={checkConnection}
				onOpenLogsFolder={openLogsFolder}
				onLoadIndexStatus={loadIndexStatus}
				onCancelIndex={cancelIndex}
				onRepairIndex={repairIndex}
				onLoadHooks={loadHooks}
				onSaveHooks={saveHooks}
				onOpenHooksFile={openHooksFile}
				onLoadAgents={loadAgents}
				onCloneAgentPreset={cloneAgentPreset}
				onLoadRulesSkills={loadRulesSkills}
				onLoadPersonas={loadPersonas}
				onOpenProjectPath={openProjectPath}
				cachedNCtx={chat.cachedNCtx}
				researchJobs={chat.researchJobs}
			/>
		);
	}

	const confirming = Boolean(chat.pendingConfirm) || Boolean(chat.pendingQuestion);
	const paused = chat.agentPaused;
	const textSize = chat.chatTextSize ?? 'default';
	const appClass = textSize === 'default' ? 'app' : `app app--text-${textSize}`;
	const researchJobs = chat.researchJobs ?? [];

	return (
		<div className={appClass}>
			<ChatHeader
				usage={chat.usage}
				maxContextTokens={chat.maxContextTokens}
				estimatedPromptTokens={chat.estimatedPromptTokens}
				contextBudget={chat.contextBudget}
				cachedNCtx={chat.cachedNCtx}
				lastContextPrune={chat.lastContextPrune}
				nearBudget={chat.nearBudget}
				nCtxWarn={chat.nCtxWarn}
				contextBreakdown={chat.contextBreakdown}
				mentionsTruncated={chat.mentionsTruncated}
				sessionId={chat.sessionId}
				sessions={chat.sessions}
				toolDetailsExpanded={toolDetailsExpanded}
				onSetToolDetailsExpanded={setToolDetailsExpandedPersist}
				thinkingDisplay={thinkingDisplay}
				onSetThinkingDisplay={setThinkingDisplayPersist}
				models={models}
				model={chat.model}
				modelsLoading={modelsLoading}
				onLoadModels={handleLoadChatModels}
			/>
			<ProjectSetupBanner project={chat.project} />
			{chat.hasExportArchive ? (
				<div className="pause-banner" role="status">
					<span className="pause-banner__text">{t('chat.restoreArchive.banner')}</span>
					<span className="pause-banner__actions">
						<button
							type="button"
							className="btn btn--secondary"
							onClick={() => vscodeApi.postMessage({ type: 'restoreExportArchive' })}
						>
							{t('chat.restoreArchive.action')}
						</button>
					</span>
				</div>
			) : null}
			{chat.nCtxWarn ? (
				<div className="pause-banner pause-banner--warn" role="status">
					<span className="pause-banner__text">{t('chat.tokens.nCtxWarnBanner')}</span>
				</div>
			) : null}
			{chat.nearBudget && !chat.nCtxWarn ? (
				<div className="pause-banner pause-banner--near" role="status">
					<span className="pause-banner__text">{t('chat.tokens.nearBudgetBanner')}</span>
					<span className="pause-banner__actions">
						<button
							type="button"
							className="btn btn--secondary"
							onClick={() => vscodeApi.postMessage({ type: 'send', text: '/compact' })}
						>
							{t('chat.contextOverflow.compactAction')}
						</button>
					</span>
				</div>
			) : null}
			{chat.todos && chat.todos.length > 0 ? <TodoPanel todos={chat.todos} /> : null}
			<MessageList
				messages={chat.messages}
				busy={chat.busy}
				detailsExpanded={toolDetailsExpanded}
				thinkingDisplay={thinkingDisplay}
				pendingConfirm={chat.pendingConfirm}
				pendingQuestion={chat.pendingQuestion}
			/>
			{(() => {
				const lastErr = [...chat.messages].reverse().find((m) => m.role === 'error');
				const overflowHint = lastErr?.content && /\/compact|context overflow|переполнен|prompt слишком большой|context budget/i.test(lastErr.content);
				if (!overflowHint || chat.busy) {
					return null;
				}
				return (
					<div className="pause-banner pause-banner--warn" role="status">
						<span className="pause-banner__text">{t('chat.contextOverflow.actionHint')}</span>
						<span className="pause-banner__actions">
							<button
								type="button"
								className="btn"
								onClick={() => vscodeApi.postMessage({ type: 'send', text: '/compact' })}
							>
								{t('chat.contextOverflow.compactAction')}
							</button>
						</span>
					</div>
				);
			})()}
			{paused ? (
				<div className="pause-banner" role="status">
					<span className="pause-banner__text">
						{t('chat.pause.maxSteps', paused.iterations)}
					</span>
					<span className="pause-banner__actions">
						<button
							type="button"
							className="btn"
							onClick={() => vscodeApi.postMessage({ type: 'continueAgent' })}
						>
							{t('chat.pause.continue')}
						</button>
						<button
							type="button"
							className="btn btn--secondary"
							onClick={() => vscodeApi.postMessage({ type: 'stopAgentPause' })}
						>
							{t('chat.pause.stop')}
						</button>
					</span>
				</div>
			) : null}
			{!paused && chat.planHandoff ? (
				<div className="pause-banner" role="status">
					<span className="pause-banner__text">
						{chat.planHandoff.title
							? `${t('chat.planHandoff.title')}: ${chat.planHandoff.title}`
							: t('chat.planHandoff.title')}
					</span>
					<span className="pause-banner__actions">
						<button
							type="button"
							className="btn"
							onClick={() => vscodeApi.postMessage({ type: 'setChatMode', mode: 'agent' })}
						>
							{t('chat.planHandoff.run')}
						</button>
						<button
							type="button"
							className="btn btn--secondary"
							onClick={() => vscodeApi.postMessage({ type: 'dismissPlanHandoff' })}
						>
							{t('chat.planHandoff.dismiss')}
						</button>
					</span>
				</div>
			) : null}
			<div className="composer-dock">
				{researchJobs.length > 0 ? (
					<ResearchJobsPanel jobs={researchJobs} compact />
				) : null}
				<Composer
					key={chat.sessionId ?? 'none'}
					busy={chat.busy || confirming}
					busyDetail={chat.busy ? chat.busyDetail : undefined}
					queuedCount={chat.queuedCount ?? 0}
					mode={chat.mode}
					sessionId={chat.sessionId}
					composerDraft={chat.composerDraft}
					composerChips={chat.composerChips}
					customSlashCommands={chat.customSlashCommands}
					imageResize={{
						attachmentImageAutoResize: settings.attachmentImageAutoResize,
						attachmentImageMaxWidth: settings.attachmentImageMaxWidth,
						attachmentImageMaxHeight: settings.attachmentImageMaxHeight,
					}}
				/>
			</div>
		</div>
	);
}
