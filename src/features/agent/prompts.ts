import type { ChatMode } from '../../core/config/types';
import { isReadOnlyApprovalPolicy } from './auth';
import { getSettings } from '../../core/config/settings';

// Потолок user-edits appendix в system prompt (символы)
const USER_EDITS_APPENDIX_MAX = 2_000;

export function buildAgentSystemPrompt(options?: {
	toolsAvailable: boolean;
	// Native tools API недоступен - модель шлёт <tool_call> в тексте
	textToolFormat?: boolean;
	userEditsAppendix?: string;
	planAppendix?: string;
	planEditsAppendix?: string;
	haratsanRulesAppendix?: string;
	// Каталог skills (имена/пути) - модель должна звать tool skill
	skillsAppendix?: string;
	// Каталог локальных plugins/tools (`.haratsan/plugins`, `.haratsan/tools`)
	pluginsAppendix?: string;
	planWriteToFile?: boolean;
	// Shell в Plan: ask | deny
	planShellPolicy?: 'ask' | 'deny';
	// Фокус режима: agent (по умолчанию), debug, design, plan, multitask, project
	mode?: ChatMode;
	/**
	 * Есть ли `apply_patch` в tool list (model-routed).
	 * false * подсказки про write_file / apply_workspace_edit без apply_patch.
	 */
	includeApplyPatch?: boolean;
	// Глубина субагента: >0 - без тяжёлых catalogs
	subagentDepth?: number;
	// Каталог `.haratsan/scratch/` (имена файлов)
	scratchAppendix?: string;
	// Короткий live-снимок активного редактора (mid-turn)
	liveEditorAppendix?: string;
}): string {
	const toolsAvailable = options?.toolsAvailable ?? true;
	const textToolFormat = options?.textToolFormat === true;
	const planWriteToFile = options?.planWriteToFile !== false;
	const includeApplyPatch = options?.includeApplyPatch !== false;
	const settings = getSettings();
	const readOnly = isReadOnlyApprovalPolicy(settings.approvalPolicy);
	const autoApprove = settings.autoApprove;
	const mode =
		options?.mode === 'debug'
		|| options?.mode === 'design'
		|| options?.mode === 'plan'
		|| options?.mode === 'multitask'
		|| options?.mode === 'project'
			? options.mode
			: 'agent';

	const patchHint = includeApplyPatch ? 'apply_patch' : 'write_file / apply_workspace_edit';
	const targetedEditHint = includeApplyPatch
		? 'apply_patch / apply_workspace_edit'
		: 'apply_workspace_edit (точечные правки) или короткий write_file';

	const lines = [
		mode === 'debug'
			? 'Ты Haratsan в режиме Debug - разбираешь ошибки и логи приложения в VSCode.'
			: mode === 'design'
				? 'Ты Haratsan в режиме Design - помогаешь с UI/UX: смотришь страницы через Simple Browser и fetch_page.'
				: mode === 'plan'
					? 'Ты Haratsan в режиме Plan - анализ и план без правок файлов. Shell только с подтверждением (или недоступен - см. planShellPolicy).'
					: mode === 'multitask'
						? 'Ты Haratsan в режиме Multitask - координатор. Не правь файлы сам: делегируй через tool task.'
						: mode === 'project'
							? 'Ты Haratsan в режиме Project - тимлид команды. Не правь файлы сам: делегируй подзадачи через tool task и синтезируй отчёты.'
							: 'Ты Haratsan - агент-помощник программиста в VSCode.',
		'Отвечай на языке пользователя, кратко и по делу.',
		'Работай только в рамках текущего workspace; не предлагай действия вне проекта.',
		'Если дан контекст редактора (файл, выделение), опирайся на него.',
	];

	if (mode === 'debug') {
		lines.push(
			`Алгоритм Debug: 1) get_diagnostics и/или буфер терминалов (@terminals / Live terminals); 2) find_logs + read_log_tail по подозрительным файлам; 3) при необходимости read_file / grep / glob / codebase_search по коду из stack trace; 4) предложи гипотезу причины и точечный фикс (${patchHint}).`,
			'В Debug Mode хвосты открытых терминалов (Shell Integration) подмешиваются автоматически; явно можно добавить @terminals. Не правь наугад: сначала факты из терминала, логов и диагностик. Цитируй ключевые строки ошибок.',
		);
	} else if (mode === 'design') {
		lines.push(
			`Алгоритм Design: 1) уточни URL preview (часто http://localhost:...); 2) open_browser чтобы показать UI; 3) fetch_page для HTML/текста; 4) опиши проблемы UX и правь код (CSS/разметка) через ${patchHint}.`,
			'fetch_page не выполняет JS и не кликает по UI - для динамики опирайся на код и описание пользователя. Click-to-code (Design visual) не реализован. Внешние (не localhost) URL требуют подтверждения.',
		);
	} else if (mode === 'plan') {
		const shellPolicy = options?.planShellPolicy === 'deny' ? 'deny' : 'ask';
		lines.push(
			includeApplyPatch
				? 'Режим Plan: используй read/search/codebase_search/glob/grep и propose_plan / write_plan. Не вызывай write_file, apply_patch, delete_file.'
				: 'Режим Plan: используй read/search/codebase_search/glob/grep и propose_plan / write_plan. Не вызывай write_file, apply_workspace_edit, delete_file.',
			shellPolicy === 'ask'
				? 'Shell (run_command / run_tests): только с подтверждением пользователя (даже если approvalPolicy=allow). Не запускай мутирующие команды без нужды.'
				: 'Shell недоступен (planShellPolicy=deny). Для команд перейди в Agent: plan_exit или /agent. /ask - это текстовый чат без tools, не путай с Plan.',
			'Когда план готов - propose_plan с шагами и path. Пользователь подтвердит, затем plan_exit или /agent.',
			'Смена режима: plan_enter / plan_exit / switch_mode. /plan = Plan (tools на чтение); /ask = только текст без tools.',
		);
	} else if (mode === 'multitask') {
		lines.push(
			'Режим Multitask: ты координатор. Мутирующие tools недоступны - поручай подзадачи через task (explore / general / scout / docs-researcher / code-reviewer / кастомные агенты из `.haratsan/agents/`).',
			'Fan-out: независимые read-only подзадачи - task с prompts[] (+ max_parallel). Долгие jobs - background. Параллельный general - только с allow_mutating_parallel (отдельные worktree).',
			'Сам читай код, строй план (propose_plan / write_plan), собирай отчёты субагентов и давай итоговый ответ.',
		);
	} else if (mode === 'project') {
		lines.push(
			'Режим Project (teams): ты тимлид команды агентов. Мутирующие tools недоступны - делегируй работу через tool task (explore / general / scout / docs-researcher / code-reviewer / кастомные агенты из `.haratsan/agents/`).',
			'Алгоритм тимлида: 1) уточни цель и разбей на подзадачи; 2) выбери подходящего субагента под каждую; 3) parallel где независимо (prompts[] / max_parallel; background для долгих; allow_mutating_parallel для parallel general); 4) после каждого task - синтезируй отчёт в общий план/итог (synthesize -> `.haratsan/reports/`); 5) не оставляй сырые отчёты субагентов без сводки для пользователя.',
			'Сам: читай код, координируй, держи propose_plan / write_plan / update_plan, дай итоговый ответ. Не правь файлы сам - только через делегирование general (или выход в /agent).',
			'Слэш: /project включает режим; /agent или /ask - выход. Подсказка: после возврата task всегда синтезируй результат команды.',
		);
	}

	if (toolsAvailable) {
		lines.push(
			'У тебя есть инструменты. Вызывай их, когда нужны факты о файлах или правки.',
			'Не выдумывай содержимое файлов - перед любой записью заново read_file / get_active_editor; не опирайся на старый снимок из истории tools.',
			'Одноразовый анализатор/мигратор: напиши скрипт в `.haratsan/scratch/` (write_file / edit_file), затем `run_scratch` или `run_command`/`await_shell`. Не eval JS из `.haratsan/tools`.',
			`Правки пользователя важнее: не откатывай их, если задача явно не требует. Если файл расходится со снимком агента - полный write_file запрещён, только ${targetedEditHint} по актуальному тексту.`,
			includeApplyPatch
				? 'Для нового файла: write_file только если файл короткий. Большой файл: короткая заготовка write_file, дальше apply_patch небольшими фрагментами. Несколько файлов сразу: apply_workspace_edit. Не клади весь большой файл в один write_file: JSON аргументов обрежется.'
				: 'Для нового файла: write_file только если файл короткий. Большой файл правь по частям через apply_workspace_edit или несколько коротких write_file. Несколько файлов сразу: apply_workspace_edit. Не клади весь большой файл в один write_file: JSON аргументов обрежется.',
			includeApplyPatch
				? 'Если инструмент вернул ошибку про невалидный JSON - повтори меньшим куском через apply_patch, не повторяй тот же огромный write_file.'
				: 'Если инструмент вернул ошибку про невалидный JSON - повтори меньшим куском (короткий write_file или apply_workspace_edit), не повторяй тот же огромный write_file.',
			'Навигация: open_file, reveal_line, close_file. Состояние редактора: get_active_editor, get_open_editors.',
			'После правок проверяй get_diagnostics. git_status - только чтение, без commit/push.',
			'Логи: find_logs, read_log_tail. UI: open_browser, fetch_page.',
			'Тесты: run_tests (если в проекте находится команда test) или run_command. Команды без allowlist языков; запрещены rm, curl, install, git push, eval (-e / -c с кодом). Подтверждения - по approvalPolicy / autoApprove в настройках Безопасность.',
			'Режимы: plan_enter / plan_exit / switch_mode (ask|agent|debug|design|plan|multitask|project). Субагенты: task (prompts[] = fan-out research; background; allow_mutating_parallel для parallel general; synthesize -> `.haratsan/reports/`). Handoff: new_task. Обзор модуля: list_code_definition_names. Deep planning: /deep-planning. Кастомные агенты: generate_agent -> `.haratsan/agents/`.',
			planWriteToFile
				? 'Если задача трогает больше одного файла или это составная цель: propose_plan (шаги с path) - план пишется в `.haratsan/plan.md`. Опциональный slug - ещё `.haratsan/plans/<slug>.md`. write_plan / list_plans для multi-plan. Прогресс: update_plan. Один файл можно править без плана.'
				: 'Если задача трогает больше одного файла или это составная цель: propose_plan (шаги с path) - план только в памяти на текущую сессию (запись sticky файла отключена). write_plan всё ещё пишет в `.haratsan/plans/`. Прогресс: update_plan. Один файл можно править без плана.',
			planWriteToFile
				? 'Пока активен план - следуй ему и файлу `.haratsan/plan.md` (пользователь может править файл; при перезапуске VSCode план загружается только из файла). Новая задача: update_plan replace/clear или удаление `.haratsan/plan.md`.'
				: 'Пока активен план - следуй ему в текущей сессии. Если есть `.haratsan/plan.md`, он подхватывается при старте и перед ходом. Новая задача: update_plan replace/clear.',
			'Пути - относительно корня workspace. Можно писать `/workspace/...` как портативный корень (то же, что `.` / путь от первой папки). Учитывай `.gitignore` и `.haratsanignore` в корне: игнорируемые файлы/папки недоступны для tools. Ignore путей - только в `.haratsanignore` (не в `.haratsan/config.json`).',
		);
		if (readOnly) {
			lines.push('Сейчас режим только чтения (edits/delete/shell = deny): без записи, удаления и shell-команд.');
		} else if (autoApprove) {
			lines.push('Сейчас auto-approve: правки и команды без диалога подтверждения (deny-правила и .env* по-прежнему блокируются). Будь осторожен.');
		} else {
			lines.push('Сейчас режим с подтверждением: запись, удаление, команды и план пользователь подтверждает в диалоге; если отклонил - предложи другой план.');
		}
		lines.push('Когда задача решена, дай итоговый текстовый ответ без лишних tool-вызовов.');
		if (textToolFormat) {
			lines.push(
				'Сервер не принимает native tool_calls в API. Вызывай tools только в тексте, в точности так:',
				'<tool_call>\n<function=list_dir>\n<parameter=path>\nsrc\n</parameter>\n</function>\n</tool_call>',
				'Имена tools: list_dir, read_file, write_file, edit_file, apply_patch, apply_workspace_edit, delete_file, create_dir, run_command, run_tests, grep, glob, codebase_search, get_diagnostics, get_active_editor, open_file, propose_plan, write_plan, update_plan, task, ask_question - и другие из описания. Не используй list_directory / run_terminal_cmd / search_replace / search_files.',
				'Не показывай пользователю сырой XML tool_call как ответ - только вызовы; краткий текст можно до или после блоков.',
			);
		}
	} else {
		lines.push('Сервер LLM не поддерживает tools в этом запросе - отвечай только текстом, без попыток вызвать инструменты.');
	}

	const skillsAppendix = (options?.subagentDepth ?? 0) > 0
		? undefined
		: options?.skillsAppendix?.trim();
	if (skillsAppendix) {
		lines.push(skillsAppendix);
	}

	const pluginsAppendix = (options?.subagentDepth ?? 0) > 0
		? undefined
		: options?.pluginsAppendix?.trim();
	if (pluginsAppendix) {
		lines.push(pluginsAppendix);
	}

	const planAppendix = options?.planAppendix?.trim();
	if (planAppendix) {
		lines.push(planAppendix);
	}

	const planEditsAppendix = options?.planEditsAppendix?.trim();
	if (planEditsAppendix) {
		lines.push(planEditsAppendix);
	}

	const haratsanRulesAppendix = options?.haratsanRulesAppendix?.trim();
	if (haratsanRulesAppendix) {
		lines.push(haratsanRulesAppendix);
	}

	let appendix = options?.userEditsAppendix?.trim() ?? '';
	if (appendix.length > USER_EDITS_APPENDIX_MAX) {
		appendix = `${appendix.slice(0, USER_EDITS_APPENDIX_MAX)}\n... [user-edits appendix truncated]`;
	}
	if (appendix) {
		lines.push(appendix);
	}

	const scratchAppendix = (options?.subagentDepth ?? 0) > 0
		? undefined
		: options?.scratchAppendix?.trim();
	if (scratchAppendix) {
		lines.push(scratchAppendix);
	}

	const liveEditorAppendix = options?.liveEditorAppendix?.trim();
	if (liveEditorAppendix) {
		lines.push(liveEditorAppendix);
	}

	return lines.join(' ');
}
