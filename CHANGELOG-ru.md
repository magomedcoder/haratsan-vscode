# Changelog

[English version](CHANGELOG.md)

## dev (Версия в разработке)

- **Index / Tree-sitter + Merkle v2:** wasm outline/AST; field-правила, пул Parser и кэш spans, `treeSitterLanguages`, OTEL `index.treesitter`; строгие движки outline/chunk; rebuild через Tree-sitter; id чанков = contentHash; `merkle.json` + leaf skip / переиспользование чанков и dirty-only vectors; patch/repair Merkle + UI mismatch; SQLite sidecar; статус wasm/AST%/skip%; CI smoke; `codebase_search` debug
- **Index:** фоновая индексация при открытии workspace (без баннера setup / opt-in `.haratsan`); команда `Haratsan: Инициализировать проект (.haratsan)` только для scaffold
- **Index storage:** индекс кодовой базы и project map перенесены в VS Code `storageUri` (больше не пишутся в `.haratsan/index` / `.haratsan/map`; миграции старых файлов проекта нет)
- **Переименование:** продукт переименован с Gen в **Haratsan** (UI, команды, настройки, пути конфига)
- **Index / semantic:** стабильные remote embeddings (batch+retry+timeout, кэш `.haratsan/index/vectors.json` по content-hash); `localEmbeddingsMode=vector` локальный dense hash index; offline eval + парафразы, `recallAtK`, local-vector gate

## 0.5.0 (30 сентября 2026)

- **Secrets:** единый SecretStorage vault; `webSearchApiKey` больше не в JSON/слоях (migrate + clear в UI); LLM apiKey через тот же vault
- **Permissions:** opt-in `persistAlwaysAllow` - Always-паттерны переживают reload (workspaceState); список/очистка в Permissions
- **Index:** Merkle `dirDigests` content-hash skip (size+mtime gate; одного path+size недостаточно); инкрементальные outline/symbols per-file (debounce watcher; full rebuild после fullIndex)
- **Outline:** multi-language MVP - non-JS через LSP `DocumentSymbolProvider` (без Tree-sitter); TS/JS по-прежнему `createSourceFile`; regex fallback только если LSP пуст
- **Tools:** `repo_health` / `test_impact` - меньше false positives, `ignore[]` + `watcherIgnore`, кэш отчёта 60s, ranked hits с reason/score
- **Tools:** `pack_context` / `similar_code` - budget токенов (`max_tokens` / `maxTokens`) с eviction низкого score; provenance в каждом hit (path, range, tool, reason, score, estimatedTokens); у `pack_context` в JSON есть `hits` (поле `text` сохранено)
- **Tools:** `find_references` multi-root (`folder`/`root`), опциональный path (workspace symbols), paging `limit`/`offset`/`page` + `total`/`hasMore`/`nextOffset`
- **Mentions:** пути с пробелами через кавычки / backticks (`@file "my dir/a.ts"`, `@file:"..."`, `` @file:`...` ``); autocomplete и paste квотят такие пути; unquoted без изменений
- **Permissions:** policy `review` для edits - unified diff в ConfirmCard до Apply (Accept / Reject / Always); больше не heuristic allow для «безопасных» путей; `autoApprove` не пропускает review
- **Index UI:** отмена идущей fullIndex (состояние `cancelled`); partial failure по файлам с сохранением успешного + `partialErrors`; Repair/Rebuild для corrupt манифеста / missing `dirDigests` (Settings -> Agent -> Indexing)
- **Eval:** gate качества retrieval (precision@k / hit-rate / simpleScore, пороги fail) на offline trigram-корпусе + merge fixtures; smoke permissions/confirm в `src/test/eval/`; запуск `npm test -- --grep eval` или `npm run test:eval` (без remote embeddings)
- **Mentions:** `@Docs` / `@past` / `@terminals` - ранжирование по релевантности query/arg + per-kind квоты токенов (docs 3k / past 2.5k / terminals 2.5k) с eviction низкого score до turn-level `fitMentionsToBudget`
- **Slash:** валидация `$ARGUMENTS` / `$n` + frontmatter `arguments:`; autocomplete ставит `/cmd ` для ввода args
- **Тесты:** матрица permission confirm (ask/deny/always/skip/abort * edits/shell + web stubs; toolsFallback Continue/Stop; continueLoopOnDeny) через pure helpers `confirmDecision` - без живого LLM
- **Permissions:** единый pipeline confirm на edits - без дублей Always/Apply после central ask/review (`shouldSkipToolConfirm` / `skipConfirm`); стабильные `awaiting_confirm` + busyDetail; conflict overwrite user edits через forceConfirm; совместимо с batch «Allow remaining»
- **Permissions:** batch confirm правок - при нескольких edits в одном turn на ConfirmCard есть **Allow remaining edits** / «Разрешить остальные правки» (только этот turn; Always / Reject / review diff без изменений; shell и `.env*` по-прежнему ask)
- **Shell:** потоковый stdout/stderr для long `run_command` / `run_tests` / `run_scratch` (карточка tool + busyDetail, throttle 120ms); cancel через AbortSignal без гонок status
- **Teams UI:** ResearchJobsPanel + Teams - карточки jobs субагентов (статус / interrupt / attach transcript), связка parent<->child сессий
- **Субагенты:** `task` `background` / interrupt / resume; fan-out `prompts[]`; `allow_mutating_parallel` для mutating parallel (worktree на job); scout/explore `cleanup_worktree` + bulk cleanup в Teams
- **Project:** `synthesize` пишет aggregate-отчёты в `.haratsan/reports/`
- **Debug:** живой захват терминала через Shell Integration (`onDidStartTerminalShellExecution` + meta cmd/exit); ANSI срезается; в Debug Mode хвосты терминалов подмешиваются сами (если нет явного `@terminals`); `@terminals` выше ранжирует ненулевой exit
- **Shell / PowerShell:** `run_scratch` умеет `.ps1` через `pwsh -File` (fallback `powershell`); file-based `pwsh`/`bash` разрешены даже из `deniedCommands`; `-Command`/`-c` по-прежнему запрещены; на Windows worktree start предпочитает `pwsh` (fallback `cmd.exe`)
- **Shell / notify_on_output:** матч только по **новому** выводу job (без false positive на старый буфер); ANSI срезается; busyDetail/partial preview при watching / MATCH
- **Shell / profiles:** `.haratsan/shell.json` - env templates и named profiles (`pathPrepend`/`pathAppend`); применяются в `run_command` / `run_tests` / `run_scratch` до хука `shell.env`; выбор: tool `profile`, `HARATSAN_SHELL_PROFILE` или `defaultProfile`
- **Sessions:** `tabEvictionPolicy` (`closeOldestIdle` по умолчанию / `block`) - на лимите `maxTabCount` new/fork/handoff закрывает самые старые idle (не current и не busy)
- **Sessions / compact:** lossless `exportArchive` на диске (ExtensionContext.storageUri / `export-archives/`); баннер + `/restore-archive` после compact; архив сбрасывается при clear/delete/restore

## 0.4.0 (11 сентября 2026)

- **Context / compact:** budget токенов для @-вложений + eviction по kind; preflight trim; `toolOutputModelMaxChars` (default 2000); один overflow retry; `midLoopAutoCompact` default on; `llmAutoCompact` default **off**; preview `/compact` + undo; near-budget / n_ctx warn + CTA `/compact`; breakdown в шапке
- **Параллельный research:** `task` с `prompts[]` (+ `max_parallel`) для read-only fan-out; статус busy; агрегированный JSON
- **Tools:** `list_code_definition_names` (top-level defs по outline, multi-root); `new_task` - handoff в новую вкладку
- **Mentions:** `@problems`, `@git-changes` (staged/unstaged); поиск outline по всем корням workspace
- **IDE:** Explain / Improve выделение; Add to Haratsan из editor / terminal / notebook; единый `haratsan.addToChat`
- **Plan <-> Act:** настройки `planModel` / `actModel`; `/deep-planning`; маршрутизация модели по режиму
- **Checkpoints:** `/undo files|task`; `/compare` (Files / Task / оба / diff); `backgroundEditMode`
- **Permissions:** быстрые пресеты (Ask all / Dev / Allow most)
- **Worktrees:** команда «Haratsan: Управление worktrees» (список / открыть / удалить)
- Plugins: `run_plugin` - spawn объявленных `command`/`args` или `bin` только под workspace (shell confirm; без `require` в host); `package.json` `haratsan`/`haratsanAgent` и `.haratsan/npm-plugins.json` в `list_plugins` (без require/execute)
- Project polish: бейдж «Project lead», усиленный промпт тимлида / `/project`, напоминание синтезировать после `task`
- Режим **project**: промпт тимлида, slash `/project`, мутирующие tools как в multitask
- **Tool confirm UX:** статус `awaiting_confirm` на карточке tool + строка busy; pretty JSON args; один центральный ask до execute; ConfirmCard в composer dock; вопрос перед text-only fallback, если сервер отклонил tools
- **Index/codebase MVP:** `localEmbeddingsMode` (`off`|`trigram`); `embeddingsBaseUrl` / `embeddingsModel`; TS outline -> `.haratsan/index/outline.json`; tools `find_references`, `design_inspect`; PDF text + до 3 PNG через `pdftoppm`; debounce outline/symbols на watcher
- Context: n_ctx probe + budget UI + hygiene; Merkle/LSP symbols/`@map`; `edit_file` / scratch / ephemeral / `repo_health`
- `smallModel`: общий `resolveSmallModel` для title + compact/summary

## 0.3.0 (7 сентября 2026)

- **Переполнение контекста:** разбор `exceed_context_size_error` (в т.ч. вложенный JSON llama.cpp); preflight оценка + shrink; auto-compact перед ходом; ограниченный retry; `contextOverflowPolicy` на экране Запросы; понятные ошибки вместо сырого HTTP 400
- Permissions v2: UI политики подтверждений (`allow` / `ask` / `review` / `deny`), Always + подсказка паттерна, session allowlist, auto-approve, continue-on-deny, capability toggles
- Карточка подтверждения: кнопка **Always** + hint; allow/deny провайдеров по паттерну (`providerUsePolicy`)
- Admin policy: блокировка security-ключей через `HARATSAN_ADMIN_POLICY` / `/etc/haratsan/policy.json` (баннер read-only в Settings)
- Slash-режимы: `/debug` `/design` `/plan` `/ask` `/agent`; также `/export` `/init` `/compact` `/new` `/undo` `/sessions` `/models`
- Режим **Plan**: правки только на чтение; shell ask или deny (`planShellPolicy`); handoff Plan<->Agent (banner + reminders)
- Multitask + `plan_enter` / `plan_exit` / `switch_mode`; артефакты WritePlan в `.haratsan/plans/`
- Experimental code-mode: opt-in tool `execute` - JSON-шаги (без eval JS на хосте)
- Skills и rules: `AGENTS.md` / `.haratsanrules`, discovery + tool `skill`, `/init`; экран Rules/Skills
- Personas: dropdown в Chat + экран Personas (`.haratsan/personas/`); экран Agents - clone builtin presets в `.haratsan/agents/`
- Локальные plugins/tools: discovery `.haratsan/tools` и `.haratsan/plugins` (каталог + `list_plugins` / `plugin`)
- Scaffold проекта: Enable / `/init` создаёт `.haratsan/{agents,commands,plugins,skills,tools,references,plans}`
- Слои конфига: user `~/.config/haratsan/config.json` + project `.haratsan/config.json`; JSON Schema + валидация VSCode
- Hooks: экран `.haratsan/hooks.json`; события `beforeSubmit` / `beforeShell` / `session.diff` / `session.compacting` / `shell.env` / `file.watcher`
- Субагенты: `task` (`explore` / `general`), лимит вложенности, опциональные git worktrees + start command после create
- Tools: `glob`, `grep`, `file_search`, `web_search`, `todo_write` / `todo_read`, `ask_question`, `edit_notebook`, `lsp`, `semantic_search` / `search_docs`
- Web search: DuckDuckGo, Exa, Parallel или custom HTTP; model-routed patch (GPT оставляет `apply_patch`)
- Shell: сохранение cwd, background `run_command` + `await_shell` (`notify_on_output`), Stop на tool + countdown, cwd/exit/`line N` на карточках
- Упоминания: `@git` `@branch_diff` `@rules` `@link` `@code` `@Docs` `@agent` `@terminals` `@past` `@alias`/`@ref`; paste path `@file`; `!command`; Ctrl+L
- Chat UX: multi-session + fork, параллельные runs по табам, drafts, AskQuestion / Todo, thinking toggle, model picker, context ring, звук notify
- Review: pending-changes с деревом файлов + Accept/Reject на файл; CodeLens Keep/Undo; git-sync auto-Keep; edit + revertFiles
- Indexing: toggles + статус движка (CPU trigram / remote embeddings); opt-in OTEL spans для LLM
- Settings UI: отдельные экраны (Чат / Агент / Индекс / Права); нав Основное / Дополнительно; все разделы всегда видны; удобнее toggles полей
- Usage: ledger токенов по моделям (totals/sort); placeholder Quota (OAuth)
- Поиск по Settings; deep-links в VSCode; sidebar или bottom panel (`chatViewLocation`); light/HC polish
- LLM: учёт `Retry-After` при 429/5xx со статусом в composer; параллельные read-only tool batches; обрезка вывода tools
- Images/attachments: paste/drag + vision; `read_file` изображений; лимиты resize; export/import сессий; lossless archive после compact

## 0.2.0 (3 сентября 2026)

- Context Engine + упоминания `@file` / `@folder` / `@codebase` в чате (автодополнение в Composer)
- Документация: английские docs без суффикса `-ru`; русские - `*-ru.md` со ссылками EN/RU
- Настройка `deniedCommands`: denylist бинарников для `run_command` перенесён из кода в настройки
- Исправление **Без спроса** (`open`): без диалогов для команд, плана и overwrite правок пользователя
- Лимит итераций агента: `0` = без лимита
- Локализация: чат/настройки webview + UI host через `l10n/bundle.l10n*.json` (EN/RU; новый язык - новый bundle-файл)
- Opt-in проекта: не создавать `.haratsan/` при открытии папки; в чате Gen кнопка **Создать конфиг и индекс** (`.haratsan/config.json` + индекс)
- Composer context chips для `@file` / `@folder` / `@codebase` (выбор из автодополнения, снятие перед отправкой)
- Редактирование user-сообщения; история после него обрезается и turn переотправляется
- Accept / Reject по хункам в карточке tool-diff в чате
- Настройки: отключить запись `.haratsan/plan.md` (`planWriteToFile`); при перезапуске план загружается из файла, не из workspaceState
- Режимы чата **Debug** / **Design**: tools логов (`find_logs`, `read_log_tail`) и Simple Browser / `fetch_page`
- **`.haratsanrules`** - опциональный файл правил проекта в system prompt agent / ask / комментариев
- Очередь turns при занятом агенте (**В очередь**; **Стоп** / **Очистить** сбрасывают очередь); итог токенов сессии в лог agent

## 0.1.0 (24 августа 2026)

- Чат и агент в bottom-панели (`ask` / `agent`)
  - streaming ответов (если сервер поддерживает)
  - кнопки `Стоп` и `Очистить`
  - очистка истории чата не перезаписывает сохранённый storage после отмены запроса
  - отображение расхода токенов (usage из API): в шапке чата и под сообщениями
- Агентный цикл и UX
  - LLM -> tool calls -> выполнение tools -> возврат результатов
  - карточки tool-call в чате (pending/ok/denied/error)
  - diff-preview для правок в режиме комментариев (и patch-first подход)
  - multi-file plan: `propose_plan` -> `.haratsan/plan.md` (sticky, переживает clear чата) + `update_plan` + карточка «Открыть» / ручной edit с diff для модели
  - локальный индекс кодовой базы (`.haratsan/index/`) + tool `codebase_search`
  - checkpoints: снапшот файлов до agent turn и предложение восстановления
  - своё подтверждение: карточка в чате Haratsan для agent, комментариев и checkpoint (без отдельной вкладки и без native MessageBox)
  - совместное редактирование: снимок после write/patch, запрет full `write_file` поверх user-diff, confirm при patch поверх правок пользователя
  - аудита в `Output` (`Haratsan`): tool, путь/детали (с redaction), длительность, ok/error/denied
- Workspace tools (sandboxed)
  - `list_dir`, `read_file`, `search_files`, `write_file`, `apply_patch`, `delete_file`, `create_dir`
  - path sandbox: запрет выхода за workspace (`..`, symlink escape, пути вне workspace)
  - `.gitignore` / `.haratsanignore` в корне workspace (пакет `ignore`, без `git check-ignore` на каждый tool)
  - подтверждение для опасных операций (write/patch/delete и т.п.)
  - git tools в read-only режиме (`git_status`), диагностика (`get_diagnostics`)
  - команды/терминал с allow/denylist политиками
- LLM-клиент
  - API key хранится в `SecretStorage` (settings -> API-ключ)
  - авторизация через `Authorization: Bearer` (или настраиваемые заголовок и схема)
  - retry для `429` и `5xx` с backoff (с сохранением ошибки/причин)
  - отмена запросов: отдельная обработка timeout vs abort
  - логи запросов в `Output` (`Haratsan LLM`) без body и без ключа
  - (опционально) запись логов на диск в фоне: `llm.log` / `agent.log` с очередью без блокировки запросов
- Настройки продукта (в основном окне редактора, не в webview-панели чата)
  - настройки разделены на страницы: «Основное», «Чат и агент», «Запросы», «Комментарии», «Безопасность», «Логи»
  - кнопка «Сбросить по умолчанию»
  - загрузка моделей по `baseUrl`
- Команды и локализация
  - категория `Haratsan` в палитре команд
  - сочетания по умолчанию: `Ctrl+Alt+G` - открыть чат; `Ctrl+Alt+/` - прокомментировать выделение
  - EN/RU: `package.nls` (манифест) и `vscode.l10n` (сообщения extension host)
- Пайплайн комментариев
  - команды: прокомментировать выделение; прокомментировать весь файл (контекстное меню редактора)
  - streaming генерации с прогрессом по символам (если сервер поддерживает)
  - few-shot примеры по семейству языка (JS/TS, Python, HTML, SQL, Lua, PHP и др.)
  - опциональный дополнительный system prompt в настройках «Комментарии»
  - извлечение кода из ответа модели (в т.ч. последний markdown-блок)
  - validate «не менять логику» + preview/diff перед apply
  - при провале validation - только «Применить всё равно», без обычного Apply
  - stale edit: проверка `document.version` и текста выделения перед apply
  - diff UX: подсветка языка virtual docs, модальное подтверждение, очистка virtual docs после закрытия diff
  - генерация комментариев с учётом языка файла и strip по языковым правилам
