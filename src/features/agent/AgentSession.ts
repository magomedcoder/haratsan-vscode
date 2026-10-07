import * as vscode from 'vscode';
import { getSettings } from '../../core/config/settings';
import type { ChatMode } from '../../core/config/types';
import { resolveModeModel } from '../../core/config/types';
import type { ChatMessage, LlmClient, LlmRetryInfo, LlmToolCall } from '../../core/llm/types';
import type { ChatUiMessage, ToolCallStatus, ToolCallUi } from '../chat/protocol';
import { pathFromToolArguments } from './diff';
import { AgentCheckpoint } from './checkpoint';
import { clearIgnoreCache } from './gitIgnore';
import { formatStickyPlanForPrompt, StickyPlan } from './plan';
import { buildAgentSystemPrompt } from './prompts';
import { includeApplyPatchForModel } from './modelRoutedPatch';
import { getHaratsanRulesManager } from '../project/haratsanRules';
import { loadProjectRulesAppendix } from '../project/projectRules';
import { discoverSkills, formatSkillsCatalog } from '../project/skills';
import { discoverLocalPlugins, formatPluginsCatalog } from '../project/plugins';
import { refreshDynamicTools } from './tools/dynamicTools';
import { unregisterEphemeralTools } from './tools/registry';
import { formatPersonaAppendix, resolvePersona } from '../project/personas';
import { formatScratchCatalog } from '../project/scratchCatalog';
import { getLiveEditorAppendix } from '../chat/editorContext';
import { recordUsage } from '../../core/stores/usageStore';
import { activityKindFromTool, recordActivity, summarizeToolActivity } from '../../core/stores/activityStore';
import { redactSecrets } from './secrets';
import { executeAgentTool, getAgentLlmTools } from './tools';
import type { ExtendedToolContext } from './tools';
import { TodoStore } from './todoStore';
import { isMutatingTool } from './auth';
import { resolveSubagent } from './subagents';
import { withAgentRoot } from './agentRoot';
import { defaultWorkspaceCwd, ShellSession } from './shellSession';
import { sanitizeToolArgumentsForApi, type ConfirmChoice, type ToolContext, type ToolResult } from './types';
import type { AgentWriteTracker } from './userEdits';
import { confirmOrSkip } from './tools/confirm';
import { countRemainingMutatingEdits } from './tools/batchEditConfirm';
import { shouldContinueToolsFallback, shouldStopLoopOnToolDeny } from './tools/confirmDecision';
import { buildUserContentWithImages, type ImageAttachment } from '../chat/attachments';
import { completeWithContextGuard, softCompactApiMessages, shrinkApiMessages, dropSupersededReminders, type ShrinkStats } from '../chat/fitContext';
import { estimateChatMessagesTokens } from '../../core/llm/estimateTokens';
import { getCachedNCtx, getEffectiveContextBudget, isNearContextBudget } from '../../core/llm/contextBudget';
import { extractTextToolCalls, stripTextToolCallsForDisplay } from './textToolCalls';

// Уникальные пути из успешного mutating tool (path или hunks)
function collectTurnDiffPaths(toolResult: ToolResult, into: Set<string>): void {
	if (!toolResult.ok) {
		return;
	}

	const path = toolResult.path?.trim();
	if (path) {
		into.add(path);
	}

	for (const hunk of toolResult.hunks ?? []) {
		const hunkPath = hunk.path?.trim();
		if (hunkPath) {
			into.add(hunkPath);
		}
	}
}

function messageId(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === 'AbortError';
}

function toAbortError(): Error {
	const err = new Error(vscode.l10n.t('agent.operationCancelled'));
	err.name = 'AbortError';
	return err;
}

function truncate(text: string, max = 4000): string {
	if (text.length <= max) {
		return text;
	}

	return `${text.slice(0, max)}\n${vscode.l10n.t('agent.truncatedChars', text.length - max)}`;
}

// Отпечаток tool+args для doom loop (похожие вызовы, не полный JSON)
function doomArgsFingerprint(name: string, rawArgs: string): string {
	try {
		const args = JSON.parse(rawArgs) as Record<string, unknown>;
		const keys = ['path', 'command', 'url', 'query', 'old_string', 'pattern', 'cwd', 'job_id', 'subagent_type', 'file'];
		const parts: string[] = [];
		for (const key of keys) {
			if (!(key in args)) {
				continue;
			}

			const value = args[key];
			const text = typeof value === 'string' ? value.slice(0, 160) : JSON.stringify(value)?.slice(0, 160) ?? '';
			parts.push(`${key}=${text}`);
		}

		if (parts.length === 0) {
			return `${name}\n${rawArgs.trim().slice(0, 240)}`;
		}

		return `${name}\n${parts.join('|')}`;
	} catch {
		return `${name}\n${rawArgs.trim().slice(0, 240)}`;
	}
}

function normalizeAgentMode(mode: ChatMode | undefined): ChatMode {
	if (mode === 'debug' || mode === 'design' || mode === 'plan' || mode === 'multitask' || mode === 'project') {
		return mode;
	}

	return 'agent';
}

function isReadonlyMode(mode: ChatMode): boolean {
	return mode === 'plan' || mode === 'multitask' || mode === 'project';
}

function historyToApiMessages(history: ChatUiMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];

	for (const msg of history) {
		if (msg.role === 'user') {
			out.push({
				role: 'user',
				content: msg.content
			});
			continue;
		}

		if (msg.role === 'assistant') {
			if (!msg.content && !msg.toolCalls?.length) {
				continue;
			}

			const toolCalls = msg.toolCalls?.map((tc) => ({
				id: tc.id,
				type: 'function' as const,
				function: {
					name: tc.name,
					arguments: sanitizeToolArgumentsForApi(redactSecrets(tc.arguments).text),
				},
			}));
			out.push({
				role: 'assistant',
				content: msg.content || null,
				...(toolCalls?.length ? {
					tool_calls: toolCalls
				} : {}),
			});
			continue;
		}

		if (msg.role === 'tool' && msg.toolCallId) {
			out.push({
				role: 'tool',
				tool_call_id: msg.toolCallId,
				content: redactSecrets(msg.content).text,
				name: msg.toolName,
			});
		}
	}

	// Убрать устаревшие compact/mode reminders из API-истории
	return dropSupersededReminders(out).messages;
}

function parseTimeoutMsFromArgs(name: string, rawArgs: string): number | undefined {
	if (name !== 'run_command') {
		return undefined;
	}

	try {
		const args = JSON.parse(rawArgs) as Record<string, unknown>;
		const value = args.timeout_ms;
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			const maxMs = getSettings().maxToolTimeoutMs || 300_000;
			return Math.min(maxMs, Math.floor(value));
		}
	} catch {}

	return undefined;
}

const SHELL_UI_TOOLS = new Set(['run_command', 'run_tests', 'await_shell', 'run_scratch']);

// Достаёт cwd/exit из текста shellExec / await_shell (строки `cwd:` и `exit:`)
function parseShellMetaFromResult(toolName: string, resultText: string): Pick<ToolCallUi, 'cwd' | 'exitCode'> {
	if (!SHELL_UI_TOOLS.has(toolName)) {
		return {};
	}

	const cwdMatch = /^cwd:\s*(.+)$/m.exec(resultText);
	const exitMatch = /^exit:\s*(\d+)/m.exec(resultText);
	const cwd = cwdMatch?.[1]?.trim();
	const exitRaw = exitMatch?.[1];
	const exitCode = exitRaw !== undefined ? Number(exitRaw) : undefined;

	return {
		...(cwd ? { cwd } : {}),
		...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}),
	};
}

function toToolCallUi(call: LlmToolCall, status: ToolCallStatus = 'pending'): ToolCallUi {
	return {
		id: call.id,
		name: call.function.name,
		arguments: call.function.arguments,
		path: pathFromToolArguments(call.function.arguments),
		status,
		startedAt: Date.now(),
		timeoutMs: parseTimeoutMsFromArgs(call.function.name, call.function.arguments),
	};
}

export type AgentUiSink = {
	append(message: ChatUiMessage): void;

	update(id: string, patch: Partial<ChatUiMessage>): void;
};

export class AgentSession {
	constructor(private readonly client: LlmClient) {}

	async run(params: {
		history: ChatUiMessage[];
		userText: string;
		editorContext?: string;
		attachments?: readonly ImageAttachment[];
		signal: AbortSignal;
		ui: AgentUiSink;
		confirm?: ToolContext['confirm'];
		// Mid-run вопрос (ask_question) - title/prompt/options * ответ строкой
		askQuestion?: (request: {
			title: string;
			prompt: string;
			options?: string[];
		}) => Promise<string>;
		revealFile?: ToolContext['revealFile'];
		trackMutation?: ToolContext['trackMutation'];
		plan?: StickyPlan;
		onPlanChanged?: ToolContext['onPlanChanged'];
		checkpoint?: AgentCheckpoint;
		writes?: AgentWriteTracker;
		planEditsAppendix?: string;
		mode?: ChatMode;
		sessionAllow?: string[];
		onAlwaysAllow?: (pattern: string) => void;
		setChatMode?: (mode: ChatMode) => void | Promise<void>;
		// Список todos текущего run для UI-панели
		onTodosChanged?: (todos: Array<{
			id: string
			content: string
			status: string
		}>) => void;
		// Колбэк перед паузой HTTP-retry (пробрасывается в LLM client)
		onRetry?: (info: LlmRetryInfo) => void;
		// Глубина вложенного субагента (0 = основной агент)
		subagentDepth?: number;
		// Принудительно только read-only tools (explore)
		readonlySubagent?: boolean;
		// Доп. system prompt для субагентов
		subagentSystem?: string;
		// Cwd для ShellSession и относительных путей (git worktree)
		cwd?: string;
		maxIterationsOverride?: number;
		// Id чат-сессии для Activity ledger
		sessionId?: string;
		// Мягкая пауза при исчерпании лимита итераций (не hard failure)
		onPaused?: (info: { reason: 'max_steps'; iterations: number }) => void;
		// Старт tool - зарегистрировать AbortController для cancelToolCall
		onToolStart?: (toolCallId: string, controller: AbortController) => void;
		// Завершение tool - снять AbortController
		onToolEnd?: (toolCallId: string) => void;
		// Строка статуса над композером (ожидание confirm и т.п.)
		onBusyDetail?: (detail: string | undefined) => void;
		// Файлы, изменённые за этот run (session diff / UI-баннер)
		onTurnDiff?: (info: { turnId: string; paths: string[] }) => void;
		// Счётчики context prune для UI/debug
		onContextPrune?: (info: { chars: number; messages: number }) => void;
		createNewTask?: (params: {
			title?: string;
			prompt: string;
			mode?: ChatMode;
			autoStart?: boolean;
		}) => Promise<{ sessionId: string; title: string }>;
		onSubagentJob?: (event: {
			id: string;
			status: 'queued' | 'running' | 'done' | 'error' | 'aborted';
			subagent: string;
			promptPreview: string;
			prompt?: string;
			detail?: string;
			worktreePath?: string;
			background?: boolean;
			mutating?: boolean;
			reportSnippet?: string;
			childSessionId?: string;
		}) => void;
		createJobAbort?: (jobId: string) => AbortSignal;
		releaseJobAbort?: (jobId: string) => void;
		openChildSessionForJob?: (params: {
			jobId: string;
			title: string;
			prompt: string;
		}) => Promise<{ sessionId: string } | undefined>;
	}): Promise<void> {
		const settings = getSettings();
		const modeModel = resolveModeModel(settings) || settings.model;
		const maxIterations = params.maxIterationsOverride ?? settings.agentMaxIterations;
		const unlimited = !params.maxIterationsOverride && maxIterations === 0;
		let toolsEnabled = true;
		const plan = params.plan ?? new StickyPlan();
		const checkpoint = params.checkpoint ?? new AgentCheckpoint();
		const writes = params.writes;
		const turnId = messageId();
		const turnDiffPaths = new Set<string>();
		const notifyTodos = (items: Array<{ 
			id: string
			content: string
			status: string
		}>) => {
			params.onTodosChanged?.(items);
		};
		const todos = new TodoStore(notifyTodos);
		notifyTodos([]);
		const rootCwd = (params.cwd?.trim() || defaultWorkspaceCwd());
		const shell = new ShellSession(rootCwd);
		const depth = params.subagentDepth ?? 0;
		let agentMode: ChatMode = normalizeAgentMode(params.mode);
		clearIgnoreCache();

		const userText = params.editorContext
			? `${params.userText}\n\n---\nКонтекст:\n${params.editorContext}`
			: params.userText;
		const userContent = await buildUserContentWithImages(userText, params.attachments);

		const userEditsAppendix = writes ? await writes.buildPromptAppendix() : '';
		const planSnap = plan.snapshot();
		const planAppendix = planSnap?.approved ? formatStickyPlanForPrompt(planSnap) : '';
		const planEditsAppendix = params.planEditsAppendix?.trim() ?? '';
		const haratsanRulesAppendix =
			(await loadProjectRulesAppendix())
			?? getHaratsanRulesManager()?.getPromptAppendix()
			?? '';
		const skillsAppendix = depth === 0 ? (formatSkillsCatalog(await discoverSkills()) ?? '') : '';
		const pluginsAppendix = depth === 0 ? (formatPluginsCatalog(await discoverLocalPlugins()) ?? '') : '';
		const scratchAppendix = depth === 0 ? ((await formatScratchCatalog()) ?? '') : '';
		if (depth === 0) {
			await refreshDynamicTools();
		}
		let personaAppendix = '';
		if (depth === 0 && settings.personaId.trim()) {
			const persona = await resolvePersona(settings.personaId);
			if (persona) {
				personaAppendix = formatPersonaAppendix(persona);
			}
		}
		const customSystem = [
			settings.systemPrompt.trim(),
			personaAppendix,
			params.subagentSystem?.trim() ?? '',
		].filter(Boolean).join('\n\n');

		let liveEditorAppendix = getLiveEditorAppendix() ?? '';
		const buildSystem = (toolsAvailable: boolean, mode: ChatMode, textToolFormat = false) => [
			customSystem,
			buildAgentSystemPrompt({
				toolsAvailable,
				textToolFormat,
				userEditsAppendix,
				planAppendix,
				planEditsAppendix,
				haratsanRulesAppendix,
				skillsAppendix,
				pluginsAppendix,
				scratchAppendix,
				liveEditorAppendix,
				planWriteToFile: settings.planWriteToFile,
				planShellPolicy: settings.planShellPolicy,
				mode,
				includeApplyPatch: includeApplyPatchForModel(modeModel, settings.modelRoutedPatch),
				subagentDepth: depth,
			}),
		].filter(Boolean).join('\n\n');

		const apiMessages: ChatMessage[] = [
			{
				role: 'system',
				content: buildSystem(true, agentMode),
			},
			...historyToApiMessages(params.history),
			{
				role: 'user',
				content: userContent,
			},
		];

		const toolCtxBase: ExtendedToolContext = {
			signal: params.signal,
			confirm: params.confirm,
			askQuestion: params.askQuestion
				? async (req) => {
					const first = req.questions[0];
					if (!first) {
						return {};
					}

					const answer = await params.askQuestion!({
						title: req.title,
						prompt: first.prompt,
						options: first.options,
					});
					return { 
						[first.id]: answer 
					};
				}
				: undefined,
			revealFile: params.revealFile,
			trackMutation: params.trackMutation,
			plan,
			onPlanChanged: params.onPlanChanged,
			checkpoint,
			writes,
			todos,
			shell,
			sessionAllow: params.sessionAllow,
			onAlwaysAllow: params.onAlwaysAllow,
			onAllowRemainingEditsThisTurn: () => {
				toolCtxBase.allowRemainingEditsThisTurn = true;
			},
			subagentDepth: depth,
			setChatMode: async (mode) => {
				await params.setChatMode?.(mode);
				if (mode === 'ask') {
					toolsEnabled = false;
					agentMode = 'agent';
				} else {
					agentMode = normalizeAgentMode(mode);
				}
				// Обновить system prompt под новый режим
				apiMessages[0] = {
					role: 'system',
					content: buildSystem(toolsEnabled, agentMode),
				};
			},
			createNewTask: params.createNewTask,
			onSubagentJob: params.onSubagentJob,
			createJobAbort: params.createJobAbort,
			releaseJobAbort: params.releaseJobAbort,
			openChildSessionForJob: params.openChildSessionForJob,
			runSubagent: async ({ type, prompt, signal, cwd }) => {
				const def = await resolveSubagent(type);
				const child = new AgentSession(this.client);
				const chunks: string[] = [];
				const runChild = async () => {
					await child.run({
						history: [],
						userText: prompt,
						signal,
						sessionId: params.sessionId,
						confirm: params.confirm,
						askQuestion: params.askQuestion,
						revealFile: params.revealFile,
						trackMutation: params.trackMutation,
						// permission.task: субагент не наследует sessionAllow родителя (строже)
						sessionAllow: undefined,
						onAlwaysAllow: params.onAlwaysAllow,
						subagentDepth: depth + 1,
						readonlySubagent: def?.readonly ?? true,
						subagentSystem: def?.prompt,
						maxIterationsOverride: def?.maxIterations ?? 12,
						cwd: cwd?.trim() || undefined,
						mode: 'agent',
						onRetry: params.onRetry,
						ui: {
							append: (message) => {
								if (message.role === 'assistant' && message.content.trim()) {
									chunks.push(message.content.trim());
								}

								if (message.role === 'error') {
									chunks.push(`[error] ${message.content}`);
								}

								params.ui.append({
									...message,
									content: message.role === 'assistant'
										? `[subagent:${type}] ${message.content}`
										: message.content,
								});
							},
							update: (id, patch) => params.ui.update(id, patch),
						},
					});
				};
				const childCwd = cwd?.trim();
				if (childCwd) {
					await withAgentRoot(childCwd, runChild);
				} else {
					await runChild();
				}
				
				return chunks.slice(-3).join('\n\n') || '(subagent finished with no text)';
			},
		};

		// Doom loop: одинаковый tool+args падает 3 раза подряд -> confirm на следующий вызов
		let doomKey = '';
		let doomFails = 0;
		let midLoopCompactDone = false;
		// API без tools: парсим <tool_call> из content и исполняем локально
		let textToolFallback = false;

		const reportPrune = (info: ShrinkStats): void => {
			if (info.prunedChars <= 0 && info.prunedMessages <= 0) {
				return;
			}

			params.onContextPrune?.({
				chars: info.prunedChars,
				messages: info.prunedMessages,
			});
		};

		try {
		for (let iteration = 0; unlimited || iteration < maxIterations; iteration += 1) {
			if (params.signal.aborted) {
				throw toAbortError();
			}

			// Live context mid-turn: короткий appendix активного редактора (если shareMode=auto)
			liveEditorAppendix = getLiveEditorAppendix() ?? '';
			apiMessages[0] = {
				role: 'system',
				content: buildSystem(toolsEnabled || textToolFallback, agentMode, textToolFallback),
			};

			const toolOpts = {
				readonly: params.readonlySubagent === true || isReadonlyMode(agentMode),
				disableTask: depth > 0,
				// субагенты не режем primaryTools
				primary: depth === 0,
				modelId: modeModel,
			};

			const assistantId = messageId();
			let streamed = '';
			let streamedThinking = '';
			params.ui.append({
				id: assistantId,
				role: 'assistant',
				content: '',
			});

			const settingsNow = getSettings();
			const budget = getEffectiveContextBudget(
				settingsNow,
				getCachedNCtx(settingsNow.baseUrl, modeModel || settingsNow.model),
			);
			if (isNearContextBudget(estimateChatMessagesTokens(apiMessages), budget)) {
				// Opt-in soft-stall: один mid-loop compact до shrink
				if (settingsNow.midLoopAutoCompact && !midLoopCompactDone) {
					midLoopCompactDone = true;
					const soft = softCompactApiMessages(apiMessages, settingsNow);
					if (soft.changed) {
						apiMessages.length = 0;
						apiMessages.push(...soft.messages);
						reportPrune(soft);
					}
				}

				const shrunk = shrinkApiMessages(apiMessages, budget, settingsNow);
				if (shrunk.changed) {
					apiMessages.length = 0;
					apiMessages.push(...shrunk.messages);
					reportPrune(shrunk);
				}
			}

			const result = await completeWithContextGuard({
				client: this.client,
				settings: settingsNow,
				getMessages: () => apiMessages,
				setMessages: (next) => {
					apiMessages.length = 0;
					apiMessages.push(...next);
				},
				complete: (messages) => this.client.complete({
					messages,
					model: modeModel || undefined,
					signal: params.signal,
					tools: toolsEnabled ? getAgentLlmTools(agentMode, toolOpts) : undefined,
					toolChoice: toolsEnabled ? 'auto' : 'none',
					onDelta: (chunk) => {
						streamed += chunk;
						params.ui.update(assistantId, {
							content: stripTextToolCallsForDisplay(streamed),
						});
					},
					onThinkingDelta: (chunk) => {
						streamedThinking += chunk;
						params.ui.update(assistantId, {
							thinking: streamedThinking
						});
					},
					onRetry: params.onRetry,
				}),
				onStatus: (detail) => {
					params.onRetry?.({
						attempt: 1,
						maxAttempts: 2,
						status: 400,
						delayMs: 0,
					});
					params.ui.update(assistantId, {
						content: stripTextToolCallsForDisplay(streamed || detail),
					});
				},
				onPrune: reportPrune,
				signal: params.signal,
			});

			if (result.toolsFallback && toolsEnabled) {
				if (params.confirm) {
					params.onBusyDetail?.(vscode.l10n.t('chat.busy.awaitingToolsFallback'));
					let choice: ConfirmChoice = 'apply';
					try {
						choice = await params.confirm({
							title: vscode.l10n.t('agent.toolsUnsupportedConfirm'),
							detail: vscode.l10n.t('agent.toolsUnsupportedDetail'),
							hint: vscode.l10n.t('confirm.panelHint'),
							variant: 'binary',
							applyLabel: vscode.l10n.t('agent.toolsUnsupportedContinue'),
							rejectLabel: vscode.l10n.t('agent.confirmStop'),
						});
					} finally {
						params.onBusyDetail?.(undefined);
					}
					if (!shouldContinueToolsFallback(choice)) {
						params.ui.append({
							id: messageId(),
							role: 'error',
							content: vscode.l10n.t('agent.toolsUnsupportedStopped'),
						});
						const stoppedExtracted = extractTextToolCalls((result.content || streamed).trim());
						params.ui.update(assistantId, {
							content: stoppedExtracted.content || vscode.l10n.t('agent.toolsUnsupportedStopped'),
							thinking: (result.thinking || streamedThinking).trim() || undefined,
							usage: result.usage,
						});
						return;
					}
				}
				// Native tools в API нет - дальше текстовые <tool_call> из content.
				toolsEnabled = false;
				textToolFallback = true;
				apiMessages[0] = {
					role: 'system',
					content: buildSystem(true, agentMode, true),
				};
				params.ui.append({
					id: messageId(),
					role: 'assistant',
					content: vscode.l10n.t('agent.toolsUnsupported'),
				});
			}

			const rawContent = (result.content || streamed).trim();
			const extracted = extractTextToolCalls(rawContent);
			let toolCalls = result.toolCalls ?? [];
			if (toolCalls.length === 0 && extracted.toolCalls.length > 0) {
				toolCalls = extracted.toolCalls;
			}
			const content = extracted.content;
			const thinking = (result.thinking || streamedThinking).trim() || undefined;
			params.ui.update(assistantId, {
				content,
				thinking,
				usage: result.usage,
			});
			if (result.usage) {
				recordUsage(
					modeModel,
					result.usage.promptTokens ?? 0,
					result.usage.completionTokens ?? 0,
				);
			}

			if (toolCalls.length === 0) {
				if (!content) {
					params.ui.update(assistantId, {
						content: vscode.l10n.t('agent.emptyModelReply'),
					});
				}
				return;
			}

			const orderedCalls = [...toolCalls].sort((a, b) => {
				if (a.function.name === 'propose_plan' && b.function.name !== 'propose_plan') {
					return -1;
				}

				if (b.function.name === 'propose_plan' && a.function.name !== 'propose_plan') {
					return 1;
				}

				return 0;
			});

			const liveCalls = orderedCalls.map((c) => toToolCallUi(c, 'pending'));
			params.ui.update(assistantId, {
				content: content || '',
				toolCalls: liveCalls.map((c) => ({ ...c })),
			});

			apiMessages.push({
				role: 'assistant',
				content: content || null,
				tool_calls: orderedCalls.map((call) => ({
					...call,
					function: {
						...call.function,
						arguments: sanitizeToolArgumentsForApi(call.function.arguments),
					},
				})),
			});

			const runOne = async (i: number) => {
				if (params.signal.aborted) {
					throw toAbortError();
				}
				const call = orderedCalls[i]!;
				const failKey = doomArgsFingerprint(call.function.name, call.function.arguments);

				// После 3 одинаковых провалов - принудительный confirm + сброс skipConfirm
				if (doomKey === failKey && doomFails >= 3) {
					toolCtxBase.skipConfirm = false;
					const denied = await confirmOrSkip(
						toolCtxBase,
						'Doom loop: повтор падающего tool',
						`Инструмент «${call.function.name}» уже трижды завершился ошибкой с похожими аргументами. Продолжить ещё раз или сменить подход?`,
					);
					if (denied) {
						const resultText = truncate(denied.content + '\n\n[doom_loop] Смени аргументы или другой tool - тот же вызов уже падал 3 раза.');
						liveCalls[i] = {
							...liveCalls[i]!,
							status: 'denied',
							result: resultText,
						};
						params.ui.update(assistantId, {
							toolCalls: liveCalls.map((c) => ({ ...c })),
						});
						params.ui.append({
							id: messageId(),
							role: 'tool',
							content: resultText,
							toolCallId: call.id,
							toolName: call.function.name,
							toolArgs: call.function.arguments,
							toolStatus: 'denied',
						});
						return {
							role: 'tool' as const,
							tool_call_id: call.id,
							name: call.function.name,
							content: redactSecrets(resultText).text,
							denied: true,
							cancelled: false,
						};
					}
				}

				// Per-tool AbortController: отмена одного tool не рвёт весь turn
				const toolAbort = new AbortController();
				const onParentAbort = () => toolAbort.abort();
				params.signal.addEventListener('abort', onParentAbort);
				if (params.signal.aborted) {
					toolAbort.abort();
				}
				params.onToolStart?.(call.id, toolAbort);

				const toolPathHint = pathFromToolArguments(call.function.arguments);
				const toolKind = activityKindFromTool(call.function.name);
				const toolSummary = summarizeToolActivity(
					call.function.name,
					call.function.arguments,
					toolPathHint,
				);
				// Старт только для заметных действий (shell / edit) - без шума от read/grep
				if (toolKind !== 'tool') {
					recordActivity({
						kind: toolKind,
						label: `${toolSummary}...`,
						path: toolPathHint,
						sessionId: params.sessionId,
						toolName: call.function.name,
						status: 'start',
					});
				}

				const finishToolUi = (
					status: ToolCallStatus,
					resultText: string,
					extra?: Partial<ToolCallUi>,
					attachments?: ImageAttachment[],
				) => {
					liveCalls[i] = {
						...liveCalls[i]!,
						status,
						result: resultText,
						...extra,
					};
					params.ui.update(assistantId, {
						toolCalls: liveCalls.map((c) => ({ ...c })),
					});
					params.ui.append({
						id: messageId(),
						role: 'tool',
						content: resultText,
						toolCallId: call.id,
						toolName: call.function.name,
						toolArgs: call.function.arguments,
						toolStatus: status,
						...(attachments?.length ? { attachments } : {}),
					});
				};

				try {
					const confirmForTool: ToolContext['confirm'] = params.confirm
						? async (req) => {
							// Стабильный awaiting_confirm + busyDetail до ответа пользователя (не сбрасываем mid-turn - иначе мигание между central и tool confirm)
							liveCalls[i] = {
								...liveCalls[i]!,
								status: 'awaiting_confirm',
							};
							params.ui.update(assistantId, {
								toolCalls: liveCalls.map((c) => ({ ...c })),
							});
							params.onBusyDetail?.(
								vscode.l10n.t('chat.busy.awaitingConfirm', call.function.name),
							);
							try {
								return await params.confirm!(req);
							} finally {
								// После Apply: оставляем busyDetail и переводим в pending без «дыры»
								if (liveCalls[i]?.status === 'awaiting_confirm') {
									liveCalls[i] = {
										...liveCalls[i]!,
										status: 'pending',
										startedAt: Date.now(),
									};
									params.ui.update(assistantId, {
										toolCalls: liveCalls.map((c) => ({ ...c })),
									});
								}
							}
						}
						: undefined;

					// Потоковый stdout shell -> tool card + busyDetail (throttle, сброс после tool)
					let lastPartialAt = 0;
					const onPartialOutput = SHELL_UI_TOOLS.has(call.function.name)
						? (text: string) => {
							if (params.signal.aborted || toolAbort.signal.aborted) {
								return;
							}

							const now = Date.now();
							if (now - lastPartialAt < 120) {
								return;
							}

							lastPartialAt = now;
							liveCalls[i] = {
								...liveCalls[i]!,
								status: 'pending',
								result: text,
							};
							params.ui.update(assistantId, {
								toolCalls: liveCalls.map((c) => ({ ...c })),
							});

							const tail = text.trim().split(/\r?\n/).slice(-2).toString().slice(0, 120);
							params.onBusyDetail?.(
								tail ? `${call.function.name}: ${tail}` : call.function.name,
							);
						}
						: undefined;

					const toolResult = await executeAgentTool(
						call.function.name,
						call.function.arguments,
						{
							...toolCtxBase,
							remainingMutatingEdits: countRemainingMutatingEdits(
								orderedCalls.map((c) => c.function.name),
								i,
							),
							confirm: confirmForTool ?? toolCtxBase.confirm,
							signal: toolAbort.signal,
							onPartialOutput,
						},
					);
					// Сброс busy после tool (confirm + streaming) - один раз, без mid-turn мигания
					params.onBusyDetail?.(undefined);
					const lengthHint = !toolResult.ok && result.finishReason === 'length'
						? vscode.l10n.t('agent.responseTruncated')
						: '';
					let resultText = truncate(`${toolResult.content}${lengthHint}`);

					if (!toolResult.ok && !toolResult.denied) {
						if (doomKey === failKey) {
							doomFails += 1;
						} else {
							doomKey = failKey;
							doomFails = 1;
						}

						if (doomFails >= 3) {
							toolCtxBase.skipConfirm = false;
							resultText = truncate(`${resultText}\n\n[doom_loop] Тот же tool+похожие args упал ${doomFails} раз подряд. Не повторяй без изменений - смени подход или попроси подтверждение.`);
						}
					} else if (toolResult.ok) {
						doomKey = '';
						doomFails = 0;
					}

					const status: ToolCallStatus = toolResult.denied ? 'denied' : toolResult.ok ? 'ok' : 'error';
					const toolAttachments = toolResult.attachments?.length ? toolResult.attachments : undefined;
					const resultPath = toolResult.path ?? liveCalls[i]!.path;
					finishToolUi(status, resultText, {
						path: resultPath,
						diff: toolResult.diff,
						hunks: toolResult.hunks,
						...parseShellMetaFromResult(call.function.name, resultText),
					}, toolAttachments);

					recordActivity({
						kind: activityKindFromTool(call.function.name),
						label: `${summarizeToolActivity(call.function.name, call.function.arguments, resultPath)} * ${status}`,
						path: resultPath,
						sessionId: params.sessionId,
						toolName: call.function.name,
						status,
					});

					// Session diff: только успешные mutating-tools
					if (toolResult.ok && isMutatingTool(call.function.name)) {
						collectTurnDiffPaths(toolResult, turnDiffPaths);
					}

					return {
						role: 'tool' as const,
						tool_call_id: call.id,
						name: call.function.name,
						content: redactSecrets(resultText).text,
						denied: Boolean(toolResult.denied),
						cancelled: false,
						attachments: toolAttachments,
					};
				} catch (err) {
					params.onBusyDetail?.(undefined);
					// Отмена только этого tool - продолжаем цикл агента
					if (isAbortError(err) && !params.signal.aborted) {
						const resultText = truncate(vscode.l10n.t('agent.operationCancelled'));
						finishToolUi('denied', resultText);
						recordActivity({
							kind: activityKindFromTool(call.function.name),
							label: `${toolSummary} * cancelled`,
							path: toolPathHint,
							sessionId: params.sessionId,
							toolName: call.function.name,
							status: 'denied',
						});
						return {
							role: 'tool' as const,
							tool_call_id: call.id,
							name: call.function.name,
							content: redactSecrets(resultText).text,
							denied: true,
							cancelled: true,
						};
					}
					throw err;
				} finally {
					params.signal.removeEventListener('abort', onParentAbort);
					params.onToolEnd?.(call.id);
				}
			};

			// Tools только на чтение - параллельно; мутирующие - строго по очереди.
			const toolApiMessages: ChatMessage[] = [];
			// Картинки из tools этого turn * synthetic user message перед следующим complete()
			const pendingToolImages: ImageAttachment[] = [];
			const collectToolImages = (atts: ImageAttachment[] | undefined) => {
				if (atts?.length) {
					pendingToolImages.push(...atts);
				}
			};
			// Batch «Allow remaining edits» действует только в пределах этого assistant turn
			toolCtxBase.allowRemainingEditsThisTurn = false;
			let i = 0;
			while (i < orderedCalls.length) {
				if (params.signal.aborted) {
					throw toAbortError();
				}

				const call = orderedCalls[i]!;
				if (isMutatingTool(call.function.name) || call.function.name === 'propose_plan' || call.function.name === 'ask_question') {
					const msg = await runOne(i);
					collectToolImages(msg.attachments);
					// cancelled (per-tool kill) - всегда продолжаем цикл
					if (shouldStopLoopOnToolDeny(Boolean(msg.denied), msg.cancelled, settings.continueLoopOnDeny)) {
						apiMessages.push({
							role: 'tool',
							tool_call_id: msg.tool_call_id,
							name: msg.name,
							content: msg.content
						});
						return;
					}
					toolApiMessages.push({
						role: 'tool',
						tool_call_id: msg.tool_call_id,
						name: msg.name,
						content: msg.content
					});
					i += 1;
					continue;
				}

				let j = i;
				while (j < orderedCalls.length && !isMutatingTool(orderedCalls[j]!.function.name) && orderedCalls[j]!.function.name !== 'propose_plan' && orderedCalls[j]!.function.name !== 'ask_question') {
					j += 1;
				}

				const batch = await Promise.all(Array.from({ length: j - i }, (_, k) => runOne(i + k)));

				for (const msg of batch) {
					collectToolImages(msg.attachments);
					toolApiMessages.push({
						role: 'tool',
						tool_call_id: msg.tool_call_id,
						name: msg.name,
						content: msg.content
					});
					if (shouldStopLoopOnToolDeny(Boolean(msg.denied), msg.cancelled, settings.continueLoopOnDeny)) {
						apiMessages.push(...toolApiMessages);
						return;
					}
				}
				i = j;
			}
			apiMessages.push(...toolApiMessages);

			// OpenAI tool role - text-only; image parts на user message перед следующей итерацией
			if (pendingToolImages.length > 0) {
				const visionContent = await buildUserContentWithImages(
					vscode.l10n.t('agent.toolImagesFollowUp'),
					pendingToolImages,
				);
				apiMessages.push({
					role: 'user',
					content: visionContent,
				});
			}
		}

		if (unlimited) {
			return;
		}

		// Мягкая пауза: не hard failure - UI предложит Continue / Stop
		params.ui.append({
			id: messageId(),
			role: 'error',
			content: vscode.l10n.t('chat.pause.maxSteps', maxIterations),
		});
		params.onPaused?.({
			reason: 'max_steps',
			iterations: maxIterations
		});
		} finally {
			todos.clear();
			if (depth === 0) {
				unregisterEphemeralTools();
			}
			params.onTurnDiff?.({
				turnId,
				paths: [...turnDiffPaths],
			});
		}
	}
}
