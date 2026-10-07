# Инструменты агента

[English version](tools.md)

Режим **Agent**. Пути только внутри workspace. Модели могут писать `/workspace/...` как портативный алиас корня первой папки workspace.

Учитываются `.gitignore` и `.haratsanignore` в корне workspace. Игнорирование путей/папок - через `.haratsanignore` (не через `config.json`). Агент **не** обходит ignore «чтобы всё видеть». Подробнее: [security-ru.md](security-ru.md).

Подтверждение - **Settings -> Безопасность**: `approvalPolicy` (`allow` / `ask` / `review` / `deny`) и `autoApprove` (ask -> allow; deny остаётся; **review** на edits всё равно требует Accept + diff). Capability-флаги могут полностью отключить terminal / file / web.

**Pipeline confirm для edits:** один central ask/review в `executeAgentTool` (Apply / Always / Skip или Accept / Reject для `review`). Edit-tools (`write_file`, `edit_file`, `apply_patch`, `apply_workspace_edit`, `edit_notebook`, `delete_file`) **не** показывают вторую карточку Always/Apply после этого (`skipConfirm`). Исключение: патч поверх правок пользователя - отдельный conflict confirm через `withForcedConfirm`.

## Раскладка (`src/features/agent/tools/`)

Builtin tools регистрируются через **registry** и лежат в папках категорий. Shared helpers (`confirm.ts`, `postEdit.ts`, `webSearchBackends.ts`) - наверху `tools/`.

| Папка     | Tools (имена)                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs/`     | `list_dir`, `read_file`, `write_file`, `apply_patch`, `edit_file`, `apply_workspace_edit`, `edit_notebook`, `delete_file`, `create_dir`                                                  |
| `search/` | `glob`, `grep`, `file_search`, `find_code`, `find_symbol`, `codebase_search`, `semantic_search`, `search_docs`, `project_map`, `pack_context`, `similar_code`                            |
| `shell/`  | `run_command`, `await_shell`, `run_tests`, `run_scratch` (+ реализация `task`)                                                                                                           |
| `ide/`    | `get_active_editor`, `get_open_editors`, `open_file`, `close_file`, `reveal_line`, `git_status`, `get_diagnostics`, `lsp`, `find_references`                                             |
| `plan/`   | `propose_plan`, `update_plan`, `write_plan`, `list_plans`, `plan_enter`, `plan_exit`, `switch_mode`                                                                                      |
| `meta/`   | `get_workspace_info`, todos / `ask_question` / `skill` / plugins / `task` / `generate_agent` / `register_ephemeral_tool` / `repo_health` / `test_impact` / web / logs / `design_inspect` |

**Новый tool:** файл в категории + `registerTool(...)` в `index.ts` категории + строка в этом doc. Предпочтительно не трогать `AgentSession` / `executeAgentTool` (исключения: ephemeral cleanup, live-editor appendix).

**Локальные `.haratsan/tools`:** markdown tools динамически попадают в тот же registry на каждом primary agent turn (`refreshDynamicTools`). Execute только возвращает тело файла - **без JS**. Коллизии с builtin пропускаются или с префиксом `local_`. Ephemeral (`register_ephemeral_tool`) живут до конца хода и снимаются через `unregisterEphemeralTools()`.

Подтверждения - **карточка в чате Haratsan** (Применить / Пропустить / Стоп или Применить / Отклонить). Панель чата фокусируется автоматически; отдельной вкладки нет.

| Tool                      | Действие                                                                                                                                    | Подтверждать                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `get_workspace_info`      | Папки workspace, имя, число документов                                                                                                      | нет                                                                         |
| `get_active_editor`       | Активный редактор: путь, язык, курсор, выделение                                                                                            | нет                                                                         |
| `get_open_editors`        | Открытые вкладки                                                                                                                            | нет                                                                         |
| `list_dir`                | Список файлов/папок (без игнорируемых)                                                                                                      | нет                                                                         |
| `read_file`               | Прочитать файл (опц. диапазон строк); PDF через `pdftotext` (+ первая страница PNG через `pdftoppm` при `visionEnabled`)                    | нет                                                                         |
| `glob`                    | Поиск путей по glob                                                                                                                         | нет                                                                         |
| `grep`                    | Точный поиск текста / regex в содержимом файлов                                                                                             | нет                                                                         |
| `find_code`               | Гибридный поиск по намерению (path/text/index/semantic/symbols -> merge; dirty/recent boosts)                                               | нет                                                                         |
| `find_symbol`             | LSP-кэш + TS outline (workspace storage `symbols.json` / `outline.json`)                                                                    | нет                                                                         |
| `codebase_search`         | Поиск по локальному индексу (триграммы, workspace storage (`storageUri/index/`))                                                            | нет                                                                         |
| `project_map`             | Дерево модулей + краткие summary (+ TS outline exports из workspace storage `outline.json`); кэш workspace storage `map/<key>/project.json` | нет                                                                         |
| `pack_context`            | Собрать top hits find_code/индекса в пределах char + token budget (`max_tokens`); hits с provenance                                         | нет                                                                         |
| `similar_code`            | Похожие фрагменты через trigram overlap; token budget + provenance на hits                                                                  | нет                                                                         |
| `propose_plan`            | План шагов; сохраняется в сессии (sticky)                                                                                                   | Спросить                                                                    |
| `update_plan`             | Статусы шагов / replace / clear активного плана                                                                                             | replace - Спросить; иначе нет                                               |
| `write_file`              | Создать / полностью перезаписать                                                                                                            | Только central ask/review (запрещён, если пользователь правил после агента) |
| `apply_patch`             | Замена `old_string` -> `new_string`                                                                                                         | Central ask/review; доп. Ask только при конфликте с правками пользователя   |
| `edit_file`               | DSL: `content` -> write_file, или `old_string`/`new_string` -> apply_patch                                                                  | Как у write/patch                                                           |
| `apply_workspace_edit`    | Несколько правок атомарно                                                                                                                   | Central ask/review; доп. Ask только при конфликте с правками пользователя   |
| `edit_notebook`           | Править / вставить ячейку Jupyter (`.ipynb`)                                                                                                | Только central ask/review                                                   |
| `delete_file`             | Удалить файл (не папку)                                                                                                                     | Только central ask                                                          |
| `create_dir`              | Создать каталог                                                                                                                             | нет                                                                         |
| `open_file`               | Открыть файл в редакторе                                                                                                                    | нет                                                                         |
| `close_file`              | Закрыть вкладку (не грязную)                                                                                                                | нет                                                                         |
| `reveal_line`             | Перейти к строке                                                                                                                            | нет                                                                         |
| `git_status`              | `git status` + `diff --stat` (без commit/push)                                                                                              | нет                                                                         |
| `get_diagnostics`         | Ошибки TS/ESLint и т.п.                                                                                                                     | нет                                                                         |
| `lsp`                     | definition / references / hover / symbols (line/character - 0-based)                                                                        | нет                                                                         |
| `find_references`         | Кто ссылается на Y: LSP refs (+ definition); path+pos / path+symbol / symbol; multi-root `folder`/`root`; `limit`/`offset`                  | нет                                                                         |
| `find_logs`               | Найти `*.log` / `logs/` в workspace                                                                                                         | нет                                                                         |
| `read_log_tail`           | Хвост лог-файла (последние N строк)                                                                                                         | нет                                                                         |
| `open_browser`            | Открыть URL в Simple Browser VSCode                                                                                                         | Спросить                                                                    |
| `fetch_page`              | HTTP GET текста/HTML (Design Mode); пометки sourceMappingURL                                                                                | Спросить; remote (не localhost) - всегда confirm                            |
| `design_inspect`          | URL + CSS selector -> outerHTML + угаданный исходник (grep class/id; не полный click-to-code)                                               | Спросить (как fetch_page)                                                   |
| `web_search`              | Веб-поиск (`duckduckgo` \| `exa` \| `parallel` \| `http`)                                                                                   | Спросить (confirmAlwaysOrSkip)                                              |
| `run_command`             | Команда в cwd workspace (allow + denylist)                                                                                                  | Спросить                                                                    |
| `run_scratch`             | Запуск файла только из `.haratsan/scratch/**` (node/python/bash по ext)                                                                     | Спросить                                                                    |
| `await_shell`             | Ждать фоновый job `run_command`; опционально regex `notify_on_output`                                                                       | нет                                                                         |
| `run_tests`               | Тесты проекта (npm / go / cargo / pytest)                                                                                                   | Спросить                                                                    |
| `list_plugins`            | Список локальных `.haratsan/tools` и `.haratsan/plugins` (без npm/JS)                                                                       | нет                                                                         |
| `plugin`                  | Загрузить описание plugin/tool по имени в контекст                                                                                          | нет                                                                         |
| `register_ephemeral_tool` | Временный markdown-tool на этот run (без JS; авто-сброс)                                                                                    | нет                                                                         |
| `repo_health`             | MVP: циклы импортов TS/JS + orphan-файлы (JSON)                                                                                             | нет                                                                         |
| `test_impact`             | Связанные `*test*` / `__tests__` по путям или git dirty                                                                                     | нет                                                                         |

## Замечания

- Локальные plugins/tools: см. [architecture-ru.md](architecture-ru.md#локальные-plugins--tools-mvp). Каталог подмешивается в system prompt; JS не исполняется.
- Режимы чата **Debug** / **Design** включаются slash-командами `/debug` / `/design` (тот же agent loop со спец. system prompt). Debug: `find_logs` + `read_log_tail` + диагностики; Design: `open_browser` + `fetch_page` / `design_inspect` (без выполнения JS / live DOM-кликов). Полный click-to-code в браузере не подключён - см. `features/design/designVisual.ts`.
- Mid-turn: при `shareMode=auto` на каждой итерации tool-loop обновляется короткий live-editor appendix (файл + сниппет выделения) в system prompt.
- Scratch: скрипты в `.haratsan/scratch/` (scaffold) и запуск только через `run_scratch` - **без** произвольного JS eval из `.haratsan/tools` / ephemeral.
- Качество: `repo_health` (циклы + orphans), `test_impact` (связанные тесты). Eval suite: `src/test/eval/` - gate качества retrieval (precision@k / hit-rate / simpleScore, offline trigram) + smoke permissions/confirm; запуск `npm test -- --grep eval` или `npm run test:eval` (без live LLM / без remote embeddings).
- Несколько файлов: сначала `propose_plan` -> файл `.haratsan/plan.md`; прогресс - `update_plan`. План переживает «Очистить» чат.
- Большой файл: короткая заготовка `write_file`, дальше `apply_patch` кусками.
- После успешного `write_file` / `apply_patch`, если у файла есть диагностики, в ответ tool добавляется короткая подсказка (tool не падает). Opt-in `formatAfterEdit` в настройках запускает `editor.action.formatDocument` после этих правок.
- Обзор проекта: `project_map` - кэшированное дерево модулей; предпочтительно `find_code` (intent: `symbol` \| `path` \| `text` \| `mixed`) - fan-out path/text/index/semantic/symbols; `find_symbol` - LSP-кэш; `pack_context` / `similar_code` - компактный pack и похожие фрагменты; `codebase_search` только по триграммному индексу; точный grep - `grep` / `glob`.
- Если пользователь правил файл после агента: полный `write_file` отклоняется; правь через `apply_patch` / `apply_workspace_edit` по свежему `read_file`.
- `run_command` без shell/pipe. Запрещённые бинарники - из `deniedCommands`. Eval / git write / package install остаются в коде. Confirm через `approvalPolicy` / `autoApprove` (Безопасность).
- После хода агента можно **Восстановить снимок**.
- Секреты в результатах tools маскируются по regexp из настроек (если заданы).
- Опционально `primaryTools` (имена tools, по одному на строку): если непусто - primary-агенту отдаются только они (пустой фильтр - откат ко всем). Субагенты список не применяют.
- Субагент `task` (`explore` / `general` / `scout` / presets / `.haratsan/agents/`):
  - `prompt` - один job; или `prompts[]` - fan-out (по умолчанию read-only research).
  - `max_parallel` - параллелизм для `prompts[]` (default 3, max 6).
  - `background` / `run_in_background` - сразу вернуть job ids; parent не блокируется.
  - `allow_mutating_parallel` - нужен для `prompts[]` у non-readonly (например `general`); каждый job в своём worktree.
  - `synthesize` - записать aggregate markdown в `.haratsan/reports/` (в Project по умолчанию **true**).
  - `open_child_session` - child-вкладка чата (parent<->child Teams UI).
  - `resume_job_id` - перезапуск aborted/error job (тот же id-префикс).
  - `cleanup_worktree` - после успешного **readonly** job удалить созданный worktree (по умолчанию **true** для explore/scout; mutating worktree не трогает). В Teams UI также есть bulk cleanup.
  - Опциональный git worktree через `worktreesEnabled` или аргумент `use_worktree`. Ветка в `.haratsan/worktrees/<slug>/` (fallback: sibling `*.haratsan-worktrees/`). Опционально `worktreeStartCommand` после create. Не git - пропуск, обычный субагент.

Политика команд подробнее: [security-ru.md](security-ru.md#команды-run_command).
