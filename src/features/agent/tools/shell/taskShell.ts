import { getSettings } from '../../../../core/config/settings';
import { asOptionalInt, asString, type ToolContext, type ToolDefinition, type ToolResult } from '../../types';
import { throwIfAborted } from '../../workspacePath';
import { listSubagentIds, resolveSubagent } from '../../subagents';
import { createAgentWorktree, removeAgentWorktree, shouldUseWorktree } from '../../worktree';
import { formatResearchAggregateMarkdown, writeProjectSynthesizeReport } from '../../projectSynthesize';
import { compileNotifyPattern, matchNotifyOnOutput } from '../../notifyOnOutput';
import { confirmAlwaysOrSkip } from '../confirm';

export interface TaskToolContext extends ToolContext {
	runSubagent?(params: {
		type: string;
		prompt: string;
		signal: AbortSignal;
		// Cwd субагента (git worktree)
		cwd?: string;
		jobId?: string;
	}): Promise<string>;
	onSubagentJob?(event: {
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
	}): void;
	// Per-job AbortSignal, связанный с parent signal (без гонок со Stop parent)
	createJobAbort?(jobId: string): AbortSignal;
	releaseJobAbort?(jobId: string): void;
	// Открыть child-вкладку для субагента (parent<->child UI)
	openChildSessionForJob?(params: {
		jobId: string;
		title: string;
		prompt: string;
	}): Promise<{ sessionId: string } | undefined>;
	subagentDepth?: number;
}

function asStringList(args: Record<string, unknown>, key: string): string[] {
	const raw = args[key];
	if (Array.isArray(raw)) {
		return raw.map((v) => String(v ?? '').trim()).filter(Boolean);
	}

	return [];
}

function asBool(args: Record<string, unknown>, key: string): boolean {
	const v = args[key];
	if (typeof v === 'boolean') {
		return v;
	}

	if (typeof v === 'string') {
		const t = v.trim().toLowerCase();
		return t === 'true' || t === '1';
	}

	return false;
}

function combineSignals(parent: AbortSignal | undefined, job: AbortSignal): AbortSignal {
	if (!parent) {
		return job;
	}

	if (parent.aborted) {
		const c = new AbortController();
		c.abort();
		return c.signal;
	}

	const merged = new AbortController();
	const onAbort = () => merged.abort();
	parent.addEventListener('abort', onAbort, { once: true });
	job.addEventListener('abort', onAbort, { once: true });
	if (job.aborted || parent.aborted) {
		merged.abort();
	}

	return merged.signal;
}

async function runOneSubagent(
	ext: TaskToolContext,
	def: {
		id: string;
		name: string;
		prompt: string;
		readonly: boolean;
	},
	prompt: string,
	ctx: ToolContext,
	worktreeCwd: string | undefined,
	jobId: string,
	opts: {
		background?: boolean;
		mutating?: boolean;
		openChild?: boolean;
		cleanupWorktree?: boolean;
	},
): Promise<{ ok: boolean; jobId: string; subagent: string; report?: string; error?: string; childSessionId?: string }> {
	const jobSignal = ext.createJobAbort?.(jobId) ?? new AbortController().signal;
	const signal = combineSignals(ctx.signal, jobSignal);
	let childSessionId: string | undefined;

	ext.onSubagentJob?.({
		id: jobId,
		status: 'running',
		subagent: def.id,
		promptPreview: prompt.slice(0, 200),
		prompt,
		worktreePath: worktreeCwd,
		background: opts.background,
		mutating: opts.mutating,
	});

	if (opts.openChild && ext.openChildSessionForJob) {
		try {
			const child = await ext.openChildSessionForJob({
				jobId,
				title: `${def.name}: ${prompt.slice(0, 40)}`,
				prompt,
			});
			childSessionId = child?.sessionId;
			if (childSessionId) {
				ext.onSubagentJob?.({
					id: jobId,
					status: 'running',
					subagent: def.id,
					promptPreview: prompt.slice(0, 200),
					prompt,
					childSessionId,
					worktreePath: worktreeCwd,
					background: opts.background,
					mutating: opts.mutating,
				});
			}
		} catch {}
	}

	const worktreeNote = worktreeCwd
		? `\n\n# Worktree\nРабочий каталог субагента: ${worktreeCwd}\nОтносительные пути и shell cwd - от этого каталога. Worktree не удаляется автоматически - cleanup через Teams UI.`
		: '';
	try {
		throwIfAborted(signal);
		const report = await ext.runSubagent!({
			type: def.id,
			prompt: `${def.prompt}\n\n# Задание\n${prompt}${worktreeNote}`,
			signal,
			cwd: worktreeCwd,
			jobId,
		});
		ext.onSubagentJob?.({
			id: jobId,
			status: 'done',
			subagent: def.id,
			promptPreview: prompt.slice(0, 200),
			prompt,
			reportSnippet: report.slice(0, 4000),
			childSessionId,
			worktreePath: worktreeCwd,
			background: opts.background,
			mutating: opts.mutating,
		});
		// Scout/explore lifecycle: после успешного readonly - убрать ephemeral worktree
		if (opts.cleanupWorktree && worktreeCwd && !opts.mutating) {
			const removed = await removeAgentWorktree(worktreeCwd);
			if (removed) {
				ext.onSubagentJob?.({
					id: jobId,
					status: 'done',
					subagent: def.id,
					promptPreview: prompt.slice(0, 200),
					prompt,
					reportSnippet: report.slice(0, 4000),
					childSessionId,
					worktreePath: undefined,
					detail: `worktree cleaned: ${worktreeCwd}`,
					background: opts.background,
					mutating: opts.mutating,
				});
			}
		}
		return {
			ok: true,
			jobId,
			subagent: def.id,
			report,
			childSessionId,
		};
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			ext.onSubagentJob?.({
				id: jobId,
				status: 'aborted',
				subagent: def.id,
				promptPreview: prompt.slice(0, 200),
				prompt,
				childSessionId,
				worktreePath: worktreeCwd,
				background: opts.background,
				mutating: opts.mutating,
			});
			throw err;
		}
		const message = err instanceof Error ? err.message : String(err);
		ext.onSubagentJob?.({
			id: jobId,
			status: 'error',
			subagent: def.id,
			promptPreview: prompt.slice(0, 200),
			prompt,
			detail: message,
			childSessionId,
			worktreePath: worktreeCwd,
			background: opts.background,
			mutating: opts.mutating,
		});
		return {
			ok: false,
			jobId,
			subagent: def.id,
			error: message,
			childSessionId,
		};
	} finally {
		ext.releaseJobAbort?.(jobId);
	}
}

async function mapPool<T>(
	items: T[],
	maxParallel: number,
	fn: (item: T, index: number) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(maxParallel, items.length) }, async () => {
		while (cursor < items.length) {
			throwIfAborted(signal);
			const idx = cursor;
			cursor += 1;
			await fn(items[idx]!, idx);
		}
	});
	await Promise.all(workers);
}

export const taskTool: ToolDefinition = {
	name: 'task',
	description:
		'Запустить субагента (explore | general | scout | docs-researcher | code-reviewer | кастомный из `.haratsan/agents/`) для подзадачи. Explore/scout/presets - read-only; general - полный набор tools. Параллельный research: prompts[] (readonly). Параллельные mutating: prompts[] + allow_mutating_parallel (отдельные worktree). background/run_in_background - не блокировать parent. synthesize - записать aggregate в `.haratsan/reports/`.',
	parameters: {
		type: 'object',
		properties: {
			subagent_type: {
				type: 'string',
				description: 'explore | general | scout | docs-researcher | code-reviewer | имя кастомного агента',
			},
			prompt: {
				type: 'string',
				description: 'Задание для субагента (один). Для fan-out используй prompts[].',
			},
			prompts: {
				type: 'array',
				items: { type: 'string' },
				description: 'Параллельные задания. Readonly - research fan-out; mutating - только с allow_mutating_parallel.',
			},
			max_parallel: {
				type: 'integer',
				description: 'Макс. одновременных субагентов для prompts[] (по умолчанию 3, max 6)',
			},
			use_worktree: {
				type: 'boolean',
				description: 'Создать git worktree под `.haratsan/worktrees/`. Для mutating parallel - worktree на каждый prompt.',
			},
			background: {
				type: 'boolean',
				description: 'Запустить в фоне: сразу вернуть job_id, не ждать отчёт (синоним run_in_background).',
			},
			run_in_background: {
				type: 'boolean',
				description: 'Алиас background=true.',
			},
			allow_mutating_parallel: {
				type: 'boolean',
				description: 'Разрешить prompts[] для non-readonly (general и т.п.); каждый job в своём worktree.',
			},
			open_child_session: {
				type: 'boolean',
				description: 'Создать child-вкладку чата для субагента (parent<->child UI).',
			},
			synthesize: {
				type: 'boolean',
				description: 'После parallel/single записать markdown-отчёт в `.haratsan/reports/` (project mode - по умолчанию true).',
			},
			cleanup_worktree: {
				type: 'boolean',
				description: 'После успешного readonly job удалить созданный worktree (по умолчанию true для scout/explore; false для mutating).',
			},
			resume_job_id: {
				type: 'string',
				description: 'Перезапуск ранее aborted/error job (новый run с тем же id-префиксом).',
			},
		},
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const ext = ctx as TaskToolContext;
		const depth = ext.subagentDepth ?? 0;
		const maxDepth = getSettings().subagentDepth;
		if (depth >= maxDepth) {
			return {
				ok: false,
				content: `Достигнут лимит вложенности субагентов (${maxDepth})`,
			};
		}

		const type = asString(args, 'subagent_type').trim() || 'explore';
		const prompts = asStringList(args, 'prompts');
		const single = asString(args, 'prompt').trim();
		if (single && prompts.length === 0) {
			prompts.push(single);
		}

		if (prompts.length === 0) {
			return {
				ok: false,
				content: 'task: нужен параметр prompt или prompts[]',
			};
		}

		const def = await resolveSubagent(type);
		if (!def) {
			const known = (await listSubagentIds()).join(', ');
			return {
				ok: false,
				content: `Неизвестный subagent_type "${type}". Доступно: ${known}`,
			};
		}

		if (!ext.runSubagent) {
			return {
				ok: false,
				content: 'Запуск субагента недоступен',
			};
		}

		const parallel = prompts.length > 1;
		const allowMutatingParallel = asBool(args, 'allow_mutating_parallel');
		const mutating = def.readonly === false;
		if (parallel && mutating && !allowMutatingParallel) {
			return {
				ok: false,
				content:
					'Параллельный fan-out (prompts[]) для mutating субагентов требует allow_mutating_parallel=true (каждый job - в отдельном worktree). Без флага - только read-only research.',
			};
		}

		const background = asBool(args, 'background') || asBool(args, 'run_in_background');
		const openChild = asBool(args, 'open_child_session');
		const chatMode = getSettings().chatMode;
		const synthesize = args.synthesize === undefined
			? chatMode === 'project'
			: asBool(args, 'synthesize');
		const resumeJobId = asString(args, 'resume_job_id').trim();
		// По умолчанию: readonly (scout/explore) чистят worktree; mutating - оставляют
		const cleanupWorktree =
			args.cleanup_worktree === undefined
				? !mutating
				: asBool(args, 'cleanup_worktree');

		const denied = await confirmAlwaysOrSkip(
			ctx,
			parallel
				? `${mutating ? 'Mutating parallel' : 'Research'} *${prompts.length} -> ${def.name}`
				: background
					? `Фон -> ${def.name}`
					: `Задача -> ${def.name}`,
			prompts.map((p, i) => `${i + 1}. ${p.slice(0, 120)}`).join('\n').slice(0, 600),
		);
		if (denied) {
			return denied;
		}

		const jobOptsBase = {
			background,
			mutating: mutating && (parallel ? allowMutatingParallel : true),
			openChild,
			cleanupWorktree: cleanupWorktree && !mutating,
		};

		const runParallel = async (): Promise<ToolResult> => {
			const maxParallel = Math.min(6, Math.max(1, asOptionalInt(args, 'max_parallel') ?? 3));
			const results: Array<{
				ok: boolean;
				jobId: string;
				subagent: string;
				report?: string;
				error?: string;
				childSessionId?: string;
			}> = [];

			await mapPool(
				prompts,
				maxParallel,
				async (prompt, idx) => {
					const jobId = resumeJobId && idx === 0
						? resumeJobId
						: `${mutating ? 'mutate' : 'research'}-${Date.now().toString(36)}-${idx}`;
					ext.onSubagentJob?.({
						id: jobId,
						status: 'queued',
						subagent: def.id,
						promptPreview: prompt.slice(0, 200),
						prompt,
						background,
						mutating: jobOptsBase.mutating,
					});

					let worktreeCwd: string | undefined;
					// Mutating parallel - всегда отдельный worktree; research - только если use_worktree
					const wantWt = mutating
						? true
						: shouldUseWorktree(args.use_worktree);
					if (wantWt) {
						const wt = await createAgentWorktree({
							taskId: `${def.id}-${idx}`,
							signal: ctx.signal,
						});
						if (wt.ok && wt.cwd) {
							worktreeCwd = wt.cwd;
						}
					}

					results[idx] = await runOneSubagent(
						ext,
						def,
						prompt,
						ctx,
						worktreeCwd,
						jobId,
						jobOptsBase,
					);
				},
				ctx.signal,
			);

			const okCount = results.filter((r) => r?.ok).length;
			let synthesizePath: string | undefined;
			if (synthesize) {
				const body = formatResearchAggregateMarkdown(
					results.map((r) => ({
						ok: r.ok,
						jobId: r.jobId,
						subagent: r.subagent,
						report: r.report,
						error: r.error,
					})),
				);
				const written = await writeProjectSynthesizeReport({
					title: `${def.name} parallel ${prompts.length}`,
					body,
					source: 'parallel-research',
					signal: ctx.signal,
				});
				if (written.ok) {
					synthesizePath = written.relative;
				}
			}

			const synthesizeHint = chatMode === 'project'
				? '\n\n[team-lead] Параллельный research завершён. Синтезируй отчёт в общий план/итог; не оставляй сырой вывод без сводки.'
				: '\n\nСинтезируй результаты research в краткий ответ пользователю.';

			return {
				ok: okCount > 0,
				content:
					JSON.stringify(
						{
							parallel: true,
							subagent: def.id,
							mutating: jobOptsBase.mutating,
							maxParallel,
							okCount,
							total: prompts.length,
							synthesizePath,
							results,
						},
						null,
						2,
					) + synthesizeHint,
			};
		};

		const runSingle = async (): Promise<ToolResult> => {
			let worktreeCwd: string | undefined;
			let worktreeMeta: Record<string, unknown> | undefined;
			if (shouldUseWorktree(args.use_worktree)) {
				const wt = await createAgentWorktree({
					taskId: def.id,
					signal: ctx.signal,
				});
				if (wt.ok && wt.cwd) {
					worktreeCwd = wt.cwd;
					worktreeMeta = {
						path: wt.cwd,
						branch: wt.branch,
						slug: wt.slug,
						detail: wt.detail,
					};
				} else {
					worktreeMeta = {
						skipped: true,
						reason: wt.detail,
					};
				}
			}

			const jobId = resumeJobId || `task-${Date.now().toString(36)}`;
			const one = await runOneSubagent(
				ext,
				def,
				prompts[0]!,
				ctx,
				worktreeCwd,
				jobId,
				jobOptsBase,
			);
			if (!one.ok) {
				return {
					ok: false,
					content: one.error ?? 'subagent failed',
				};
			}

			let synthesizePath: string | undefined;
			if (synthesize && one.report) {
				const written = await writeProjectSynthesizeReport({
					title: `${def.name} ${jobId}`,
					body: one.report,
					source: 'task',
					signal: ctx.signal,
				});
				if (written.ok) {
					synthesizePath = written.relative;
				}
			}

			const synthesizeHint = chatMode === 'project'
				? '\n\n[team-lead] Субагент завершил задачу. Синтезируй отчёт в общий план/итог для пользователя; не оставляй сырой вывод без сводки.'
				: '';
			return {
				ok: true,
				content:
					JSON.stringify(
						{
							subagent: def.id,
							jobId,
							childSessionId: one.childSessionId,
							synthesizePath,
							...(worktreeMeta ? { worktree: worktreeMeta } : {}),
							report: one.report,
						},
						null,
						2,
					) + synthesizeHint,
			};
		};

		if (background) {
			// Фон: сразу вернуть job ids; выполнение сам запускает runOneSubagent с этими id
			const stamp = Date.now().toString(36);
			const jobs = prompts.map((prompt, i) => {
				const jobId = resumeJobId && i === 0
					? resumeJobId
					: `bg-${stamp}-${i}`;
				ext.onSubagentJob?.({
					id: jobId,
					status: 'queued',
					subagent: def.id,
					promptPreview: prompt.slice(0, 200),
					prompt,
					background: true,
					mutating: jobOptsBase.mutating,
				});
				return { jobId, prompt };
			});

			void (async () => {
				try {
					const maxParallel = Math.min(6, Math.max(1, asOptionalInt(args, 'max_parallel') ?? 3));
					await mapPool(
						jobs,
						maxParallel,
						async (item) => {
							let worktreeCwd: string | undefined;
							const wantWt = mutating
								? (parallel ? true : shouldUseWorktree(args.use_worktree))
								: shouldUseWorktree(args.use_worktree);
							if (wantWt) {
								const wt = await createAgentWorktree({
									taskId: `${def.id}-${item.jobId}`,
									signal: ctx.signal,
								});

								if (wt.ok && wt.cwd) {
									worktreeCwd = wt.cwd;
								}
							}
							await runOneSubagent(
								ext,
								def,
								item.prompt,
								ctx,
								worktreeCwd,
								item.jobId,
								jobOptsBase,
							);
						},
						ctx.signal,
					);
				} catch (err) {
					if (err instanceof Error && err.name === 'AbortError') {
						return;
					}

					const message = err instanceof Error ? err.message : String(err);
					for (const j of jobs) {
						ext.onSubagentJob?.({
							id: j.jobId,
							status: 'error',
							subagent: def.id,
							promptPreview: j.prompt.slice(0, 200),
							prompt: j.prompt,
							detail: message,
							background: true,
						});
					}
				}
			})();

			return {
				ok: true,
				content: JSON.stringify(
					{
						background: true,
						subagent: def.id,
						jobIds: jobs.map((j) => j.jobId),
						hint: 'Jobs запущены в фоне. Следи за Teams UI / interruptResearchJob; parent может продолжать работу.',
					},
					null,
					2,
				),
			};
		}

		if (parallel) {
			return runParallel();
		}

		return runSingle();
	},
};

export const awaitShellTool: ToolDefinition = {
	name: 'await_shell',
	description: 'Дождаться фонового job от run_command (background=true), проверить статус по job_id, или дождаться regex в **новом** выводе (notify_on_output; ANSI срезается; без false positive на старый буфер).',
	parameters: {
		type: 'object',
		properties: {
			job_id: {
				type: 'string',
				description: 'ID фоновой задачи от run_command (background=true)',
			},
			timeout_ms: {
				type: 'integer',
				description: 'Сколько ждать завершения или совпадения паттерна (по умолчанию 60000)',
			},
			notify_on_output: {
				type: 'string',
				description: 'Regex только по выводу, появившемуся после вызова await_shell (не по всей истории job)',
			},
			debounce_ms: {
				type: 'integer',
				description: 'После совпадения: ждать столько мс без роста вывода (по умолчанию 0 - сразу; min 0)',
			},
		},
		required: ['job_id'],
		additionalProperties: false,
	},
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		throwIfAborted(ctx.signal);
		const shell = (ctx as ToolContext & { shell?: import('../../shellSession').ShellSession }).shell;
		if (!shell) {
			return {
				ok: false,
				content: 'Shell-сессия недоступна',
			};
		}

		const jobId = asString(args, 'job_id').trim();
		const job = shell.getJob(jobId);
		if (!job) {
			return {
				ok: false,
				content: `Неизвестный job_id: ${jobId}`,
			};
		}

		const patternRaw = asString(args, 'notify_on_output').trim();
		let notifyPattern: RegExp | undefined;
		if (patternRaw) {
			const compiled = compileNotifyPattern(patternRaw);
			if (!compiled.ok) {
				return {
					ok: false,
					content: `Некорректный regex notify_on_output: ${compiled.error}`,
				};
			}

			notifyPattern = compiled.pattern;
		}

		const debounceMs = Math.max(0, asOptionalInt(args, 'debounce_ms') ?? 0);
		const timeoutMs = Math.min(300_000, Math.max(1000, Number(args.timeout_ms) || 60_000));
		const deadline = Date.now() + timeoutMs;
		// Матчим только новый вывод - срез на старте await
		const fromOffset = job.output.length;
		let lastLen = job.output.length;
		let lastGrowthAt = Date.now();
		let matchLatched = false;

		const matchedAndSettled = (): boolean => {
			if (!notifyPattern) {
				return false;
			}

			const hit = matchNotifyOnOutput({
				output: job.output,
				fromOffset,
				pattern: notifyPattern,
			});
			if (!hit.matched) {
				matchLatched = false;
				return false;
			}

			matchLatched = true;
			if (job.done || debounceMs === 0) {
				return true;
			}

			return Date.now() - lastGrowthAt >= debounceMs;
		};

		if (notifyPattern) {
			ctx.onPartialOutput?.(
				`await_shell: watching /${patternRaw}/ on ${jobId} (from offset ${fromOffset})...`,
			);
		}

		while (!job.done && Date.now() < deadline) {
			throwIfAborted(ctx.signal);
			const len = job.output.length;
			if (len !== lastLen) {
				lastLen = len;
				lastGrowthAt = Date.now();
				if (notifyPattern) {
					const preview = matchNotifyOnOutput({
						output: job.output,
						fromOffset,
						pattern: notifyPattern,
					});
					ctx.onPartialOutput?.(
						preview.matched
							? `await_shell: MATCH /${patternRaw}/ (debounce ${debounceMs}ms)\n${preview.slice.slice(-800)}`
							: `await_shell: watching /${patternRaw}/...\n${preview.slice.slice(-400)}`,
					);
				}
			}

			if (matchedAndSettled()) {
				return {
					ok: true,
					content: `совпадение notify_on_output: /${patternRaw}/ (новый вывод)\n` +
						shell.formatJob(job) +
						(job.done ? '' : '\n(статус: ещё выполняется / совпал паттерн)'),
				};
			}
			await new Promise((r) => setTimeout(r, 200));
		}

		if (matchedAndSettled()) {
			return {
				ok: job.done ? job.exitCode === 0 : true,
				content: `совпадение notify_on_output: /${patternRaw}/ (новый вывод)\n` +
					shell.formatJob(job) +
					(job.done ? '' : '\n(статус: ещё выполняется / совпал паттерн)'),
			};
		}

		return {
			ok: job.done ? job.exitCode === 0 : true,
			content: shell.formatJob(job)
				+ (job.done ? '' : '\n(статус: ещё выполняется / таймаут ожидания)')
				+ (notifyPattern && !matchLatched ? `\n(notify_on_output /${patternRaw}/: нет совпадения в новом выводе)` : ''),
		};
	},
};
