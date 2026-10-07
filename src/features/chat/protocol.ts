import type { ChatMode, ChatTextSize, HaratsanSettings } from '../../core/config/types';
import type { TokenUsage } from '../../core/llm/usage';
import type { ConfirmChoice } from '../agent/types';
import type { DiffHunkPayload, HunkReviewStatus } from '../agent/diff';
import type { ActivityEntry } from '../../core/stores/activityStore';
import type { ModelUsage } from '../../core/stores/usageStore';
import type { IndexEngineStatus } from '../index/engineStatus';
import type { SessionSummary } from './sessionStore';

export type { ActivityEntry } from '../../core/stores/activityStore';
export type { IndexEngineStatus } from '../index/engineStatus';
export type { ChatMode, ConfirmChoice, DiffHunkPayload, HunkReviewStatus };
export type ChatRole = 'user' | 'assistant' | 'error' | 'tool';
export type PanelScreen = 'chat' | 'settings';
export type ToolCallStatus = 'pending' | 'awaiting_confirm' | 'ok' | 'error' | 'denied';
export type ConfirmVariant = 'agent' | 'binary';

/**
 * Design Mode visual click-to-code: см. `features/design/designVisual.ts`.
 * MVP: tool `design_inspect` + fetch_page source hints; полный click bridge в Simple Browser ещё нет.
 */

// Снимок admin policy для Settings UI (баннер locked keys)
export interface AdminPolicyInfo {
	active: boolean;
	path?: string;
	lockedKeys: string[];
}

export interface ToolCallUi {
	id: string;
	name: string;
	arguments: string;
	status: ToolCallStatus;
	result?: string;
	path?: string;
	diff?: string;
	hunks?: DiffHunkPayload[];
	// Epoch ms - когда tool стал pending (для countdown)
	startedAt?: number;
	// Таймаут tool в мс (например timeout_ms у run_command)
	timeoutMs?: number;
	// Рабочий каталог shell (из вывода `cwd:`)
	cwd?: string;
	// Код выхода shell (из вывода `exit:`)
	exitCode?: number;
}

export interface AgentPausedState {
	reason: 'max_steps';
	iterations: number;
}

export interface ChatUiMessage {
	id: string;
	role: ChatRole;
	content: string;
	// Reasoning/thinking от модели (только если API реально отдал)
	thinking?: string;
	toolCalls?: ToolCallUi[];
	toolCallId?: string;
	toolName?: string;
	toolArgs?: string;
	toolStatus?: ToolCallStatus;
	usage?: TokenUsage;
	// Картинки, сохранённые в `.haratsan/attachments/`
	attachments?: Array<{ path: string; mimeType: string }>;
}

export interface PendingConfirm {
	id: string;
	title: string;
	detail?: string;
	hint?: string;
	variant: ConfirmVariant;
	applyLabel: string;
	skipLabel: string;
	stopLabel: string;
	rejectLabel: string;
	alwaysLabel?: string;
	suggestion?: string;
	allowAlways?: boolean;
	// Кнопка «Allow remaining edits» при очереди edits в turn
	allowRemaining?: boolean;
	allowRemainingLabel?: string;
	remainingEdits?: number;
}

// Вопрос агента mid-run (ask_question)
export interface PendingQuestion {
	id: string;
	title: string;
	prompt: string;
	options?: string[];
}

export interface ChatTodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

// Статус research/subagent job для Teams UI
export type ResearchJobStatus = 'running' | 'done' | 'error' | 'aborted' | 'queued';

// Карточка research job в chat state (host заполняет, webview только отображает/шлёт interrupt)
export interface ResearchJobUi {
	id: string;
	status: ResearchJobStatus;
	subagent: string;
	promptPreview: string;
	// Полный prompt для resume (не обязательно показывать в UI)
	prompt?: string;
	detail?: string;
	parentSessionId?: string;
	childSessionId?: string;
	worktreePath?: string;
	background?: boolean;
	mutating?: boolean;
	startedAt?: number;
	finishedAt?: number;
	reportSnippet?: string;
}

// Файлы, изменённые успешными mutating-tools за один agent run
export interface SessionDiffEvent {
	turnId: string;
	paths: string[];
	// Epoch ms - когда ход завершился
	at: number;
}

export interface ChatProjectStatus {
	hasWorkspace: boolean;
	enabled: boolean;
	indexing: boolean;
	ready: boolean;
	error?: string;
	fileCount?: number;
	chunkCount?: number;
}

export interface ChatViewState {
	messages: ChatUiMessage[];
	busy: boolean;
	// Детали busy-состояния (например статус HTTP-retry)
	busyDetail?: string;
	// Сообщения в очереди, пока идёт текущий turn
	queuedCount: number;
	mode: ChatMode;
	usage?: TokenUsage;
	// Лимит контекста для context ring
	maxContextTokens?: number;
	// Оценка prompt tokens: server usage.promptTokens если есть, иначе char-estimate
	estimatedPromptTokens?: number;
	// Effective prompt budget после n_ctx / reserves
	contextBudget?: number;
	// Закэшированный n_ctx сервера (если probe/overflow уже знал)
	cachedNCtx?: number;
	// ~80% budget - soft warning
	nearBudget?: boolean;
	// maxContextTokens > cachedNCtx
	nCtxWarn?: boolean;
	contextBreakdown?: {
		history: number;
		mentions: number;
		system: number;
		user: number;
	};
	mentionsTruncated?: boolean;
	mentionsTruncatedKinds?: string[];
	// Последний prune context (debug)
	lastContextPrune?: { 
		chars: number; 
		messages: number 
	};
	sessionId?: string;
	sessions?: SessionSummary[];
	pendingConfirm?: PendingConfirm;
	pendingQuestion?: PendingQuestion;
	todos?: ChatTodoItem[];
	project?: ChatProjectStatus;
	// Кастомные slash из `.haratsan/commands` для автодополнения Composer
	customSlashCommands?: Array<{
		id: string;
		name: string;
		detail?: string;
		mode?: ChatMode;
		needsArgs?: boolean;
		argsHint?: string;
		minPositionalArgs?: number;
	}>;
	// Мягкая пауза агента (лимит итераций) - Continue / Stop в UI
	agentPaused?: AgentPausedState;
	// Id tool, который сейчас выполняется (для per-tool kill)
	activeToolCallId?: string;
	// Размер текста чата из настроек (для CSS class на .app)
	chatTextSize?: ChatTextSize;
	// План подтверждён в mode=plan - баннер «Run in Agent»
	planHandoff?: { title?: string };
	// Текущая session-модель из getSettings().model
	model?: string;
	// Diff последнего agent-хода (уникальные пути)
	lastTurnDiff?: SessionDiffEvent;
	// Черновик Composer для текущей сессии (persist per sessionId)
	composerDraft?: string;
	// Chips Composer (insert-строки mention) для текущей сессии
	composerChips?: string[];
	// Live research/subagent jobs (Teams UI)
	researchJobs?: ResearchJobUi[];
	// Есть lossless-архив до compact (память / диск) - баннер Restore
	hasExportArchive?: boolean;
}

export type ToWebviewMessage = | { type: 'state'; state: ChatViewState }
	| { type: 'settings'; settings: HaratsanSettings; apiKeySet: boolean; webSearchApiKeySet?: boolean; persistedAlwaysAllow?: string[]; personas?: PersonaOption[]; adminPolicy?: AdminPolicyInfo }
	| { type: 'settingsSaved'; settings: HaratsanSettings; apiKeySet: boolean; webSearchApiKeySet?: boolean; persistedAlwaysAllow?: string[]; personas?: PersonaOption[]; adminPolicy?: AdminPolicyInfo }
	| { type: 'settingsError'; message: string }
	| { type: 'models'; models: Array<{ id: string; label: string }>; requestId: number }
	| { type: 'modelsError'; message: string; requestId: number }
	| { type: 'connectionHealth'; ok: boolean; modelCount: number; message: string; requestId: number }
	| { type: 'mentionSuggestions'; requestId: number; items: MentionSuggestion[] }
	| { type: 'usageLedger'; ledger: Record<string, ModelUsage> }
	| { type: 'activityLedger'; entries: ActivityEntry[] }
	| { type: 'indexStatus'; status: IndexEngineStatus }
	| { type: 'hooksData'; beforeSubmit: string[]; beforeShell: string[]; sessionDiff: string[]; sessionCompacting: string[]; shellEnv: string[]; fileWatcher: string[]; path?: string; error?: string; }
	| { type: 'hooksSaved'; ok: boolean; error?: string }
	// Builtin presets + кастомные агенты из `.haratsan/agents/`
	| { type: 'agentsData'; presets: AgentPresetInfo[]; custom: AgentCustomInfo[]; error?: string }
	| { type: 'agentsCloned'; relativePath: string; created: boolean; error?: string }
	// Кандидаты rules + discovered skills/plugins (read-only UI)
	| { type: 'rulesSkillsData'; rules: Array<{ label: string; path: string; exists: boolean }>; skills: Array<{ name: string; description: string; path: string }>; plugins: Array<{ kind: 'tool' | 'plugin' | 'npm'; name: string; description: string; path: string }>; }
	// Список персон (builtin + `.haratsan/personas/*.md`) для Settings * Personas
	| { type: 'personasData'; personas: PersonaOption[] }
	// Короткий beep в chat webview (завершение хода)
	| { type: 'playNotifySound' };

export interface AgentPresetInfo {
	id: string;
	name: string;
	description: string;
	readonly: boolean;
	mode?: string;
}

export interface AgentCustomInfo {
	id: string;
	name: string;
	description: string;
	readonly: boolean;
}

export interface PersonaOption {
	id: string;
	name: string;
	description: string;
	// Workspace-relative путь к `.md` (пусто у builtin)
	path?: string;
	// Источник: встроенный пресет или `.haratsan/personas/*.md`
	source?: 'builtin' | 'custom';
}

export interface MentionSuggestion {
	kind: 'file' | 'folder' | 'codebase' | 'code' | 'git' | 'git_changes' | 'branch_diff' | 'problems' | 'rules' | 'link' | 'docs' | 'agent' | 'terminals' | 'past' | 'alias' | 'ref' | 'map' | 'symbols';
	label: string;
	insert: string;
	detail?: string;
}

export interface IncomingImagePayload {
	name: string;
	mimeType: string;
	base64: string;
}

export type FromWebviewMessage = | { type: 'ready' }
	| { type: 'send'; text: string; images?: IncomingImagePayload[] }
	| { type: 'cancel' }
	| { type: 'clear' }
	| { type: 'setChatMode'; mode: ChatMode }
	| { type: 'setModel'; model: string }
	| { type: 'openExternal'; url: string }
	| { type: 'openSettings' }
	| { type: 'saveSettings'; settings: HaratsanSettings; apiKey?: string; clearApiKey?: boolean; webSearchApiKey?: string; clearWebSearchApiKey?: boolean; persistedAlwaysAllow?: string[] }
	| { type: 'loadModels'; baseUrl: string; requestId: number }
	| { type: 'checkConnection'; baseUrl: string; requestId: number }
	| { type: 'openLogsFolder' }
	| { type: 'confirmChoice'; id: string; choice: ConfirmChoice }
	| { type: 'answerQuestion'; id: string; answer: string }
	| { type: 'mentionSuggest'; requestId: number; query: string }
	| { type: 'retryIndex' }
	| { type: 'editMessage'; id: string; content: string; revertFiles?: boolean }
	| { type: 'reviewHunk'; toolCallId: string; hunkId: string; action: 'accept' | 'reject' }
	| { type: 'reviewDiff'; toolCallId: string; action: 'acceptAll' | 'rejectAll' }
	// Accept/Reject всех pending-хунков одного файла (сессионная панель)
	| { type: 'reviewPendingPath'; path: string; action: 'accept' | 'reject' }
	| { type: 'newSession' }
	| { type: 'switchSession'; id: string }
	| { type: 'renameSession'; id: string; title: string }
	| { type: 'deleteSession'; id: string }
	| { type: 'forkSession'; messageId: string }
	// Черновик Composer (debounce на webview); chips - insert-строки
	| { type: 'setComposerDraft'; text: string; chips?: string[]; sessionId?: string }
	| { type: 'loadUsage' }
	| { type: 'resetUsage' }
	| { type: 'loadActivity' }
	| { type: 'clearActivity' }
	| { type: 'loadIndexStatus' }
	| { type: 'cancelIndex' }
	| { type: 'repairIndex' }
	| { type: 'loadHooks' }
	| { type: 'saveHooks'; beforeSubmit: string[]; beforeShell: string[]; sessionDiff: string[]; sessionCompacting: string[]; shellEnv: string[]; fileWatcher: string[]; }
	| { type: 'openHooksFile' }
	| { type: 'loadAgents' }
	| { type: 'cloneAgentPreset'; id: string }
	| { type: 'loadRulesSkills' }
	// Пересканировать персоны (builtin + `.haratsan/personas/*.md`)
	| { type: 'loadPersonas' }
	// Открыть путь проекта / абсолютный файл в редакторе (или http(s) во внешнем браузере)
	| { type: 'openProjectPath'; path: string }
	| { type: 'continueAgent' }
	| { type: 'stopAgentPause' }
	| { type: 'cancelToolCall'; id: string }
	| { type: 'dismissPlanHandoff' }
	| { type: 'dismissTurnDiff' }
	| { type: 'openPath'; path: string }
	// Research / Teams
	| { type: 'interruptResearchJob'; id?: string; jobId?: string }
	| { type: 'interruptAllResearch' }
	| { type: 'resumeResearchJob'; id?: string; jobId?: string }
	| { type: 'openChildSession'; sessionId: string }
	| { type: 'attachResearchTranscript'; id?: string; jobId?: string }
	| { type: 'cleanupWorktree'; path: string }
	| { type: 'removeWorktree'; path: string }
	| { type: 'cleanupAllFinishedWorktrees' }
	| { type: 'openProjectReport'; path: string }
	/** Восстановить полную историю из exportArchive после compact */
	| { type: 'restoreExportArchive' };
