import type { ApprovalPolicy } from './approvalTypes';
import { DEFAULT_APPROVAL_POLICY } from './approvalTypes';

export type ChatMode = 'ask' | 'agent' | 'debug' | 'design' | 'plan' | 'multitask' | 'project';
export type CommentStyle = 'inline' | 'block';
export type ChatTextSize = 'compact' | 'default' | 'large';
// Как показывать reasoning/thinking в чате
export type ThinkingDisplay = 'off' | 'collapsed' | 'expanded';
// Где показывать чат: нижняя панель / activity bar / оба
export type ChatViewLocation = 'panel' | 'sidebar' | 'both';
// Политика при переполнении контекста (local engines / long chats)
export type ContextOverflowPolicy = 'auto_compact_retry' | 'ask' | 'fail_fast';
// Режим share активного редактора
export type ShareMode = 'manual' | 'auto' | 'disabled';
// Как открывать файл после правки агента: never / preview (без фокуса) / focus
export type RevealOnEdit = 'never' | 'preview' | 'focus';
// Бэкенд web_search: DuckDuckGo HTML, Exa/Parallel presets или произвольный HTTP JSON API
export type WebSearchBackend = 'duckduckgo' | 'exa' | 'parallel' | 'http';
/**
 * Shell в режиме Plan: `ask` - run_command/run_tests с обязательным confirm;
 * `deny` - shell tools скрыты (как раньше). Правки в Plan всегда запрещены.
 */
export type PlanShellPolicy = 'deny' | 'ask';
// При лимите вкладок: блокировать new / закрывать самые старые idle
export type TabEvictionPolicy = 'block' | 'closeOldestIdle';
/**
 * Политика `provider.use`:
 * - `allow` - allowlist (пустой список = всё разрешено; иначе нужен match)
 * - `deny` - denylist (match * отказ)
 */
export type ProviderUsePolicy = 'allow' | 'deny';

// Режимы с tool-calling (не «просто чат»)
export function isAgentLikeMode(mode: ChatMode): boolean {
	return mode === 'agent' || mode === 'debug' || mode === 'design' || mode === 'plan' || mode === 'multitask' || mode === 'project';
}

// Модель для title / compact / summary; пусто - undefined (fallback на основную в client)
export function resolveSmallModel(settings: Pick<HaratsanSettings, 'smallModel'>): string | undefined {
	const m = settings.smallModel.trim();
	return m || undefined;
}

// Модель для текущего режима: planModel в Plan, actModel в agent-like, иначе model
export function resolveModeModel(
	settings: Pick<HaratsanSettings, 'model' | 'planModel' | 'actModel' | 'chatMode'>,
): string {
	if (settings.chatMode === 'plan') {
		const p = settings.planModel.trim();
		if (p) {
			return p;
		}
	} else if (settings.chatMode !== 'ask') {
		const a = settings.actModel.trim();
		if (a) {
			return a;
		}
	}

	return settings.model.trim();
}

export interface HaratsanSettings {
	baseUrl: string;
	model: string;
	/**
	 * Дешёвая модель для title / summary / compaction (пусто - как основная)
	 */
	smallModel: string;
	/**
	 * Модель для режима Plan (пусто - как model)
	 */
	planModel: string;
	/**
	 * Модель для Agent / Act и прочих agent-like режимов (пусто - как model)
	 */
	actModel: string;
	/**
	 * Режим чата по умолчанию: ask / agent / debug / design / plan / multitask / project
	 */
	chatMode: ChatMode;
	/**
	 * Максимум итераций agent loop (LLM -> tools -> LLM)
	 *
	 * 0 - без лимита
	 * min - 0
	 * max - 40
	 * default - 40
	 */
	agentMaxIterations: number;
	/**
	 * Политика подтверждений по типам действий (shell / edits / delete / ...)
	 */
	approvalPolicy: ApprovalPolicy;
	/**
	 * Авто-одобрять ask (deny остаётся deny)
	 */
	autoApprove: boolean;
	/**
	 * Сохранять Always-паттерны между перезагрузками (workspaceState).
	 * Default false - только на текущую сессию вкладки.
	 */
	persistAlwaysAllow: boolean;
	/**
	 * Не рвать agent loop после deny - вернуть причину модели и продолжить
	 */
	continueLoopOnDeny: boolean;
	/**
	 * Подмешивать контекст workspace в prompt
	 */
	enableWorkspaceContext: boolean;
	/**
	 * Always-on: короткая сводка (git status -sb, недавние файлы) в каждый turn.
	 * Отдельно от shareMode (активный редактор / выделение).
	 */
	alwaysOnWorkspaceContext: boolean;
	/**
	 * Режим share активного редактора: manual | auto | disabled.
	 * default - manual
	 */
	shareMode: ShareMode;
	/**
	 * Имена tools только для primary-агента (пустой список = все доступные).
	 * Субагенты этот фильтр не применяют.
	 */
	primaryTools: string[];
	/**
	 * Model-routed patch: GPT-семейство получает `apply_patch`; остальные - только write/edit.
	 * false - всегда отдавать `apply_patch` (как раньше).
	 * default - true
	 */
	modelRoutedPatch: boolean;
	/**
	 * Отображаемое имя пользователя в контексте агента (`User: ...`).
	 * Пусто - не подмешивать.
	 */
	usernameDisplay: string;
	/**
	 * Glob/gitignore-паттерны: FS-watcher не переиндексирует совпавшие пути.
	 * default - []
	 */
	watcherIgnore: string[];
	/**
	 * После правки агента: не открывать / preview без фокуса / focus (как раньше).
	 * default - never
	 */
	revealOnEdit: RevealOnEdit;
	/**
	 * Фоновые правки: не открывать/фокусировать редактор (эквивалент revealOnEdit=never).
	 * default - true
	 */
	backgroundEditMode: boolean;
	/**
	 * Показать vscode notification, когда ход агента завершён.
	 */
	notifyOnComplete: boolean;
	/**
	 * Короткий beep в chat webview при завершении хода (если notifyOnComplete).
	 */
	notifySoundOnComplete: boolean;
	/**
	 * Разрешить чтение файлов tools
	 */
	enableFileReading: boolean;
	/**
	 * Разрешить терминал / run_command
	 */
	enableTerminal: boolean;
	/**
	 * Разрешить web_search
	 */
	webSearchEnabled: boolean;
	/**
	 * Бэкенд web_search: duckduckgo (по умолчанию) | exa | parallel | http
	 */
	webSearchBackend: WebSearchBackend;
	/**
	 * URL HTTP-бэкенда: шаблон с `{query}` или база, к которой дописывается `?q=`
	 * (только для `http`; Exa/Parallel используют фиксированные endpoints)
	 */
	webSearchHttpUrl: string;
	/**
	 * Имя заголовка для API-ключа HTTP-бэкенда (например Authorization).
	 * Для exa/parallel игнорируется - всегда `x-api-key`.
	 */
	webSearchHttpHeader: string;
	/**
	 * Deprecated in JSON: ключ только в SecretStorage (`haratsan.webSearchApiKey`).
	 * Поле в HaratsanSettings всегда пустое в effective settings (совместимость типов).
	 */
	webSearchApiKey: string;
	/**
	 * Разрешить fetch_page / @link
	 */
	webFetchEnabled: boolean;
	/**
	 * Доп. system prompt для чата/агента (поверх правил проекта)
	 */
	systemPrompt: string;
	/**
	 * Температура
	 *
	 * min - 0,
	 * max - 2,
	 *
	 * default - 0.2
	 *
	 * лучше держать низкой для стабильного формата
	 */
	temperature: number;
	/**
	 * Максимум токенов в ответе модели
	 *
	 * min - 64
	 *
	 * default - 8192
	 */
	maxTokens: number;
	/**
	 * Оценка окна контекста (токены) для UI / budget; сверка с n_ctx сервера при overflow.
	 * default - 128000
	 */
	maxContextTokens: number;
	/**
	 * Что делать при exceed_context_size / preflight overflow:
	 * auto_compact_retry - ужать/повторить; ask - понятная ошибка; fail_fast - сразу ошибка.
	 * default - auto_compact_retry
	 */
	contextOverflowPolicy: ContextOverflowPolicy;
	/**
	 * Таймаут HTTP-запроса в миллисекундах
	 *
	 * min - 1000
	 *
	 * default - 120000
	 */
	requestTimeoutMs: number;
	/**
	 * Таймаут tool/shell по умолчанию (мс), если в args нет timeout_ms
	 * default - 60000
	 */
	defaultToolTimeoutMs: number;
	/**
	 * Верхняя граница таймаута tool/shell (мс).
	 * default - 300000
	 */
	maxToolTimeoutMs: number;
	/**
	 * Максимальное количество символов на входе
	 *
	 * min - 500
	 *
	 * default - 8000
	 */
	maxInputChars: number;
	/**
	 * Стиль комментариев
	 *
	 * inline - короткие строковые комментарии
	 * block - короткие блочные комментарии
	 */
	commentStyle: CommentStyle;
	previewBeforeApply: boolean;
	/**
	 * Дополнительные инструкции к system prompt для комментариев
	 * Пусто - только стандартный prompt
	 */
	commentSystemPrompt: string;
	/**
	 * Glob-шаблоны запрещённых путей (по одному на строку).
	 * Пусто - ничего не запрещать. 
	 * На первом запуске НЕ автозаполняем (см. EXAMPLE_DENIED_PATHS).
	 * Для `.env*` по умолчанию используй `sensitivePathPatterns`, а не этот список.
	 */
	deniedPaths: string[];
	/**
	 * Glob’ы чувствительных путей: запись/удаление всегда ask (или deny по политике),
	 * даже при autoApprove / session-allow. Default: `.env`, `.env.*`.
	 * Не путать с `deniedPaths` (жёсткий deny на уровне sandbox).
	 */
	sensitivePathPatterns: string[];
	/**
	 * Разрешить пути вне workspace folders (external_directory).
	 * false (по умолчанию) - deny; true - resolve + approval action `outside`.
	 */
	allowExternalDirectory: boolean;
	/**
	 * Имена бинарников, запрещённых для run_command (по одному на строку).
	 * Пусто - не запрещать по имени (eval / git write / package install остаются в коде).
	 */
	deniedCommands: string[];
	/**
	 * JS-регулярки для маскировки секретов в тексте, уходящем в LLM.
	 * Пусто - не маскировать.
	 */
	secretPatterns: string[];
	/**
	 * Политика использования провайдера: allowlist / denylist по паттернам.
	 * default - allow
	 */
	providerUsePolicy: ProviderUsePolicy;
	/**
	 * Glob-паттерны (`*`) для host из baseUrl или model id.
	 * Пусто + allow = всё разрешено; пусто + deny = ничего не запрещено.
	 */
	providerUsePatterns: string[];
	/**
	 * Имя HTTP-заголовка с ключом.
	 * Пусто - Authorization.
	 */
	authHeader: string;
	/**
	 * Схема значения (Bearer).
	 * Пусто - сырой ключ без префикса.
	 */
	authScheme: string;
	/**
	 * Писать план агента в `.haratsan/plan.md` в workspace.
	 * Выключено - план только в памяти сессии.
	 */
	planWriteToFile: boolean;
	/**
	 * Shell в Plan: `ask` (default) - команды только с confirm; `deny` - shell недоступен.
	 * Не влияет на Debug/Design/Multitask; правки в Plan всегда запрещены.
	 */
	planShellPolicy: PlanShellPolicy;
	/**
	 * Снимки файлов для /undo (checkpoint + undo stack).
	 * Выключено - remember no-op, стек undo не пополняется.
	 */
	snapshotEnabled: boolean;
	/**
	 * Писать логи в Output и в файлы.
	 * По умолчанию выключено.
	 */
	loggingEnabled: boolean;
	/**
	 * Opt-in OpenTelemetry spans вокруг LLM complete().
	 * По умолчанию выключено.
	 */
	otelEnabled: boolean;
	/**
	 * OTLP HTTP URL (JSON). Пусто - без экспорта: spans в Output Haratsan LLM».
	 * Не передавать API-ключи в URL.
	 */
	otelEndpoint: string;
	/**
	 * Максимум символов в ответе одного tool (обрезка хвоста) - UI/хранение.
	 */
	toolOutputMaxChars: number;
	/**
	 * Макс. символов tool output в model path при shrink/prune (отдельно от UI card).
	 * default - 2000
	 */
	toolOutputModelMaxChars: number;
	/**
	 * Лимит вложенности tool `task` (субагенты).
	 * min - 1, max - 4, default - 2
	 */
	subagentDepth: number;
	/**
	 * Git worktrees для субагентов (`task`): по умолчанию создавать worktree под `.haratsan/worktrees/`.
	 * Переопределяется аргументом `use_worktree` у tool `task`.
	 * default - false
	 */
	worktreesEnabled: boolean;
	/**
	 * Команда (shell `-c`), один раз после `git worktree add` в cwd worktree.
	 * Пусто - не запускать. Пример: `npm install` / `yarn`.
	 */
	worktreeStartCommand: string;
	/**
	 * Доп. каталоги skills (относительно workspace или абсолютные).
	 * Базовые: `.haratsan/skills`, `.agents/skills`.
	 */
	skillsPaths: string[];
	/**
	 * HTTPS URL на удалённые SKILL.md (имя из basename URL).
	 */
	skillsUrls: string[];
	/**
	 * HTTPS URL с инструкциями - текст append к project rules.
	 */
	instructionUrls: string[];
	/**
	 * Id персоны из `.haratsan/personas/*.md` (пусто - без персоны).
	 */
	personaId: string;
	/**
	 * После успешного write_file / apply_patch форматировать документ (editor.action.formatDocument).
	 * По умолчанию выключено.
	 */
	formatAfterEdit: boolean;
	/**
	 * Git-sync auto-Keep: если pending-файл clean в git (нет изменений по path) - принять pending-хунки.
	 * По умолчанию выключено.
	 */
	gitSyncAutoKeep: boolean;
	/**
	 * Включить semantic_search / embeddings / автоиндексацию.
	 */
	indexingEnabled: boolean;
	/**
	 * Автоиндексировать новые workspace folders при открытии.
	 * default - true
	 */
	indexNewFolders: boolean;
	/**
	 * Разрешить codebase_search / semantic_search по индексу.
	 * grep / glob работают независимо.
	 * default - true
	 */
	indexForGrep: boolean;
	/**
	 * Base URL для OpenAI-compatible POST /embeddings (пусто - как baseUrl).
	 */
	embeddingsBaseUrl: string;
	/**
	 * Модель эмбеддингов.
	 */
	embeddingsModel: string;
	/**
	 * Локальный offline semantic path:
	 * - off: только remote embeddings (+ persistent vector cache)
	 * - trigram: remote при наличии; fallback trigram / local-vector (default)
	 * - vector: локальный dense index (feature hashing) без сети
	 */
	localEmbeddingsMode: 'off' | 'trigram' | 'vector';
	/**
	 * Сколько последних ходов оставлять при /compact.
	 * min - 1, max - 40, default - 4
	 */
	compactTailTurns: number;
	/**
	 * При compact агрессивно ужимать tool-результаты и args в старых ходах.
	 * default - true
	 */
	compactPruneToolResults: boolean;
	/**
	 * Зарезервированный headroom токенов при compact (placeholder для будущей логики).
	 * default - 0
	 */
	compactReservedTokens: number;
	/**
	 * Mid-loop soft-stall: при near-budget один раз сжать apiMessages перед shrink (rule-based, без LLM).
	 * default - true
	 */
	midLoopAutoCompact: boolean;
	/**
	 * LLM auto-compact перед turn, если после rule-based path всё ещё over budget.
	 * default - false (ручной /compact всегда доступен)
	 */
	llmAutoCompact: boolean;
	/**
	 * Передавать картинки в chat completions как image_url (OpenAI-compatible multimodal).
	 * По умолчанию выключено: в сообщение попадает только `[image path]`.
	 */
	visionEnabled: boolean;
	/**
	 * Максимум длины base64 одной картинки в запросе к модели (символы).
	 * default - 400000
	 */
	attachmentImageMaxBase64: number;
	/**
	 * Макс. ширина картинки перед отправкой (webview resize при ImageBitmap).
	 * default - 2048
	 */
	attachmentImageMaxWidth: number;
	/**
	 * Макс. высота картинки перед отправкой (webview resize при ImageBitmap).
	 * default - 2048
	 */
	attachmentImageMaxHeight: number;
	/**
	 * Уменьшать картинки в Composer (createImageBitmap + canvas), если превышают max W/H.
	 * Host по-прежнему режет по attachmentImageMaxBase64.
	 * default - true
	 */
	attachmentImageAutoResize: boolean;
	/**
	 * Размер текста в чате (сообщения и composer).
	 * default - 'default'
	 */
	chatTextSize: ChatTextSize;
	/**
	 * Показ reasoning/thinking в чате: скрыть / свёрнуто / развёрнуто.
	 * default - 'collapsed'
	 */
	thinkingDisplay: ThinkingDisplay;
	/**
	 * Где показывать Haratsan chat: нижняя панель / боковая панель (activity bar) / оба.
	 * default - 'both'
	 */
	chatViewLocation: ChatViewLocation;
	/**
	 * Максимум открытых чат-сессий (вкладок).
	 * min - 1, max - 40, default - 10
	 */
	maxTabCount: number;
	/**
	 * Максимум одновременных agent/ask runs по всем вкладкам.
	 * min - 1, max - 10, default - 3
	 */
	maxConcurrentRuns: number;
	/**
	 * Что делать при new/fork/handoff, если вкладок уже maxTabCount.
	 * block - предупреждение; closeOldestIdle - закрыть самые старые idle (не current, не busy).
	 * default - closeOldestIdle
	 */
	tabEvictionPolicy: TabEvictionPolicy;
}

// Примеры для кнопки в Security settings - не подставляются в deniedPaths автоматически
export const EXAMPLE_DENIED_PATHS: string[] = ['.env','.env.*','credentials.json','secrets.json','id_rsa','id_ed25519','id_ecdsa','.npmrc','.pypirc','.netrc','*.pem','*.key','*.p12','*.pfx','node_modules','.git',];

// Default sensitivePathPatterns: правки `.env*` -> ask/deny, отдельно от deniedPaths
export const DEFAULT_SENSITIVE_PATH_PATTERNS: string[] = ['.env', '.env.*'];

export const EXAMPLE_DENIED_COMMANDS: string[] = ['sudo', 'doas', 'su', 'rm', 'rmdir', 'unlink', 'dd', 'mkfs', 'fdisk', 'chmod', 'chown', 'chgrp', 'curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'docker', 'podman', 'kubectl', 'nerdctl', 'sh', 'bash', 'zsh', 'fish', 'dash', 'csh', 'tcsh', 'cmd', 'powershell', 'pwsh',];

export const EXAMPLE_SECRET_PATTERNS: string[] = [
	String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
	String.raw`\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"]?[^\s'"]{8,}`,
	String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
	String.raw`\bBearer\s+[A-Za-z0-9\-._~+/]+=*`,
];

export const DEFAULT_SETTINGS: HaratsanSettings = {
	baseUrl: '',
	model: '',
	smallModel: '',
	planModel: '',
	actModel: '',
	chatMode: 'ask',
	agentMaxIterations: 40,
	approvalPolicy: structuredClone(DEFAULT_APPROVAL_POLICY),
	autoApprove: false,
	persistAlwaysAllow: false,
	continueLoopOnDeny: true,
	enableWorkspaceContext: true,
	alwaysOnWorkspaceContext: false,
	shareMode: 'manual',
	primaryTools: [],
	modelRoutedPatch: true,
	usernameDisplay: '',
	watcherIgnore: [],
	revealOnEdit: 'never',
	backgroundEditMode: true,
	notifyOnComplete: false,
	notifySoundOnComplete: false,
	enableFileReading: true,
	enableTerminal: true,
	webSearchEnabled: true,
	webSearchBackend: 'duckduckgo',
	webSearchHttpUrl: '',
	webSearchHttpHeader: 'Authorization',
	webSearchApiKey: '',
	webFetchEnabled: true,
	systemPrompt: '',
	temperature: 0.2,
	maxTokens: 8192,
	maxContextTokens: 128_000,
	contextOverflowPolicy: 'auto_compact_retry',
	requestTimeoutMs: 120_000,
	defaultToolTimeoutMs: 60_000,
	maxToolTimeoutMs: 300_000,
	maxInputChars: 8000,
	commentStyle: 'inline',
	previewBeforeApply: true,
	commentSystemPrompt: '',
	deniedPaths: [],
	sensitivePathPatterns: [...DEFAULT_SENSITIVE_PATH_PATTERNS],
	allowExternalDirectory: false,
	deniedCommands: [...EXAMPLE_DENIED_COMMANDS],
	secretPatterns: [],
	providerUsePolicy: 'allow',
	providerUsePatterns: [],
	authHeader: 'Authorization',
	authScheme: 'Bearer',
	planWriteToFile: true,
	planShellPolicy: 'ask',
	snapshotEnabled: true,
	loggingEnabled: false,
	otelEnabled: false,
	otelEndpoint: '',
	toolOutputMaxChars: 12_000,
	toolOutputModelMaxChars: 2_000,
	subagentDepth: 2,
	worktreesEnabled: false,
	worktreeStartCommand: '',
	skillsPaths: [],
	skillsUrls: [],
	instructionUrls: [],
	personaId: '',
	formatAfterEdit: false,
	gitSyncAutoKeep: false,
	indexingEnabled: true,
	indexNewFolders: true,
	indexForGrep: true,
	embeddingsBaseUrl: '',
	embeddingsModel: 'text-embedding-3-small',
	localEmbeddingsMode: 'trigram',
	compactTailTurns: 4,
	compactPruneToolResults: true,
	compactReservedTokens: 0,
	midLoopAutoCompact: true,
	llmAutoCompact: false,
	visionEnabled: false,
	attachmentImageMaxBase64: 400_000,
	attachmentImageMaxWidth: 2048,
	attachmentImageMaxHeight: 2048,
	attachmentImageAutoResize: true,
	chatTextSize: 'default',
	thinkingDisplay: 'collapsed',
	chatViewLocation: 'both',
	maxTabCount: 10,
	maxConcurrentRuns: 3,
	tabEvictionPolicy: 'closeOldestIdle',
};
