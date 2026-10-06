# Настройки

[English version](settings.md)

Кнопка **Сбросить по умолчанию** возвращает все поля к defaults; **API-ключ не сбрасывается**.

## Экраны настроек

В боковой панели один плоский список (**6 экранов**). Внутри экрана - сворачиваемые секции.

**Подключение** (вкл. Запросы) **Чат** **Агент** (вкл. Индекс) **Безопасность** (вкл. Права) **Проект** (Rules, Personas, Agents, Hooks) **Журнал** (Usage, Activity, Логи).

Для любого OpenAI-compatible endpoint укажите Base URL и модель (например `http://127.0.0.1:8080/v1` для llama.cpp).

## Слои конфига (JSON)

Effective `HaratsanSettings` собирается из нескольких слоёв (приоритет **низкий  высокий**):

1. Встроенные `DEFAULT_SETTINGS`
2. User: `~/.config/haratsan/config.json`; override: `HARATSAN_CONFIG_DIR`
3. Haratsan Settings UI (extension `globalState`) - только поля, **отличающиеся от defaults**
4. Project: `<workspace>/.haratsan/config.json` (только явно заданные ключи)
5. **Admin policy** (наивысший): блокирует/форсирует security-subset - project/UI не могут переопределить

**Не реализовано:** remote `.well-known`, полный MDM/SSO.

### Admin policy (managed)

Опциональный машинный policy-файл (первый найденный):

1. `HARATSAN_ADMIN_POLICY` - абсолютный путь (если задан - только он)
2. Linux / macOS: `/etc/haratsan/policy.json`
3. Windows: `%ProgramData%/haratsan/policy.json`

Ключи из файла **блокируются** и форсируют effective settings. Lock-ключи: `approvalPolicy`, `autoApprove`, `continueLoopOnDeny`, `enableTerminal`, `enableFileReading`, `enableWorkspaceContext`, `webSearchEnabled`, `webFetchEnabled`, `allowExternalDirectory`, `otelEnabled`, `otelEndpoint`, `providerUsePolicy`, `providerUsePatterns`.

Пример:

```json
{
  "$schema": "./schemas/haratsan-policy.schema.json",
  "webSearchEnabled": false,
  "webFetchEnabled": false,
  "allowExternalDirectory": false,
  "otelEnabled": false
}
```

При активной политике в Haratsan Settings - баннер только для чтения со списком locked keys. Schema: `schemas/haratsan-policy.schema.json` (опционально; в `jsonValidation` не подключена).

UI настроек Haratsan не ломается: слои аддитивны. Project перекрывает user и изменённые UI-поля по ключам из JSON; admin побеждает для locked keys. Единственный ключ в VSCode Settings (`haratsan.chatViewLocation`) синхронизируется из effective config для `when`-clause views.

Поддерживаемые ключи JSON (subset `HaratsanSettings`): `systemPrompt`, `commentSystemPrompt`, `primaryTools`, `watcherIgnore`, `webSearch*` (`webSearchBackend`: `duckduckgo` \| `exa` \| `parallel` \| `http`), `webFetchEnabled`, `skillsPaths` / `skillsUrls` / `instructionUrls`, `personaId`, `usernameDisplay`, deny/security lists, agent/indexing knobs, timeouts, `chatMode`, `planShellPolicy` (`ask` \| `deny`), `shareMode`, `revealOnEdit`, `thinkingDisplay`, `chatViewLocation`, и др. - полный список в `FILE_LAYER_KEYS` (`src/core/config/layers.ts`).

Дополнительно в JSON:

- `hooksPath` - путь к `hooks.json` (относительно workspace или абсолютный)
- `hooks` - inline-команды хуков (как в `.haratsan/hooks.json`); непустые списки перекрывают файл

### Хуки (`.haratsan/hooks.json`)

Shell-команды по событиям. Всегда есть `HARATSAN_HOOK_EVENT`. Ненулевой exit - **veto**, если не указано notify-only.

| Событие              | Когда                                          | Payload (env)                                                                                        | stdout / управление                                                                                             |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `beforeSubmit`       | Перед отправкой в чат                          | `HARATSAN_HOOK_TEXT`                                                                                 | exit ≠ 0 * блокирует send                                                                                       |
| `beforeShell`        | Перед shell-инструментами агента               | `HARATSAN_HOOK_COMMAND`                                                                              | exit ≠ 0 * блокирует команду                                                                                    |
| `shell.env`          | После `beforeShell`, перед spawn `run_command` | `HARATSAN_HOOK_COMMAND` / `HARATSAN_HOOK_COMMAND`, `HARATSAN_HOOK_CWD`                               | JSON `{"env":{"K":"V"}}` / `{"K":"V"}` или строки `KEY=value` * merge в env дочернего процесса; exit ≠ 0 * veto |
| `session.diff`       | После записи файлов turn’ом                    | `HARATSAN_HOOK_PATHS`, `HARATSAN_HOOK_TURN_ID`                                                       | только notify                                                                                                   |
| `session.compacting` | Перед `/compact`                               | -                                                                                                    | exit ≠ 0 * блокирует compact                                                                                    |
| `file.watcher`       | Debounce изменений под `.haratsan/**`          | `HARATSAN_HOOK_PATH`, `HARATSAN_HOOK_FILE_EVENT`, `HARATSAN_HOOK_PATHS`, `HARATSAN_HOOK_FILE_EVENTS` | только notify                                                                                                   |

Алиасы: `sessionDiff` / `session.diff`, `shellEnv` / `shell.env`, `fileWatcher` / `file.watcher`.

Метаданные project-файла (`version`, `createdAt`, `$schema`) в settings не попадают. Массивы (например `deniedPaths`, `skillsPaths`) при merge **заменяются** целиком, не склеиваются.

### JSON Schema

С установленным расширением VSCode валидирует файлы через `contributes.jsonValidation` (`$schema` не обязателен):

| Файл                                                             | Схема в расширении                   |
| ---------------------------------------------------------------- | ------------------------------------ |
| `**/.haratsan/config.json`, `**/gen/config.json` (user XDG)      | `schemas/gen-config.schema.json`     |
| `**/.haratsan/hooks.json`                                        | `schemas/gen-hooks.schema.json`      |
| `**/.haratsan/references.json`, `**/.haratsan/references/*.json` | `schemas/gen-references.schema.json` |

Опциональный `$schema` (редакторы без расширения или явное закрепление версии):

```json
{
  "$schema": "https://raw.githubusercontent.com/magomedcoder/haratsan-vscode/main/schemas/gen-config.schema.json"
}
```

Аналогично для hooks / references - подставьте имя файла (`gen-hooks.schema.json`, `gen-references.schema.json`). Относительный путь, если схемы лежат в workspace: `"$schema": "./schemas/gen-config.schema.json"` (с поправкой на глубину).

## Основное

| Поле            | По умолчанию    | Описание                                                                                                      |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| Базовый URL     | пусто           | Корень API: в первую очередь **llama.cpp** (`http://127.0.0.1:8080`), также любой OpenAI-совместимый endpoint |
| API-ключ        | -               | В `SecretStorage`; пусто - заголовок не отправлять                                                            |
| Заголовок ключа | `Authorization` | Имя HTTP-заголовка                                                                                            |
| Схема ключа     | `Bearer`        | Префикс значения; пустая схема - сырой ключ                                                                   |
| Модель          | пусто           | Идентификатор модели; список грузится по URL                                                                  |

## Чат и агент

| Поле           | По умолчанию | Описание                   |
| -------------- | ------------ | -------------------------- |
| Режим чата     | `ask`        | Ask или Agent              |
| Лимит итераций | `40`         | 0 = без лимита; иначе 1-40 |

Права: **Settings -> Безопасность** (`approvalPolicy` / `autoApprove`) - см. [chat-ru.md](chat-ru.md#права-безопасность).

Настройки комментариев - на экране **Чат** (сворачиваемая секция **Комментарии**): стиль, diff перед apply, доп. system prompt. Подробнее: [comments-ru.md](comments-ru.md).

## Запросы

| Поле                    | По умолчанию | Описание                                  |
| ----------------------- | ------------ | ----------------------------------------- |
| Температура             | `0.2`        | 0-2; для стабильного формата лучше низкая |
| Макс. токенов ответа    | `8192`       | min 64                                    |
| Таймаут (мс)            | `120000`     | min 1000                                  |
| Макс. символов на входе | `8000`       | Лимит для фрагмента комментариев и т.п.   |

## Безопасность

| Поле                | По умолчанию        | Описание                                                                   |
| ------------------- | ------------------- | -------------------------------------------------------------------------- |
| Запрещённые пути    | пусто               | Glob’ы по одному на строку (`deniedPaths`)                                 |
| Запрещённые команды | встроенный denylist | Имена бинарников для `run_command`, по одному на строку (`deniedCommands`) |
| Шаблоны секретов    | пусто               | JS-regexp; совпадения -> `[REDACTED]`                                      |

Есть кнопки «Вставить примеры». Полная политика путей и команд: [security-ru.md](security-ru.md).

### Web search (`web_search`)

Бэкенд (`webSearchBackend`, UI: Request / Запросы):

| Значение               | Ключ                              | Endpoint                                                                                                  |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `duckduckgo` (default) | нет                               | HTML scrape DuckDuckGo                                                                                    |
| `exa`                  | `webSearchApiKey` * `x-api-key`   | `POST https://api.exa.ai/search` (`query`, `numResults`)                                                  |
| `parallel`             | `webSearchApiKey` * `x-api-key`   | `POST https://api.parallel.ai/v1/search` (`objective`, `search_queries`, `advanced_settings.max_results`) |
| `http`                 | опц. ключ + `webSearchHttpHeader` | GET `webSearchHttpUrl` с `{query}`                                                                        |

Ключ поддерживает `${env:NAME}` / `{file:path}`. Ответ нормализуется в `{ title, url }[]` (ожидаемые поля: `results[].title`/`url`; title может отсутствовать * fallback на url). Exa/Parallel - best-effort adapters по публичным docs.

## Логи

| Поле        | По умолчанию | Описание                                                  |
| ----------- | ------------ | --------------------------------------------------------- |
| Писать логи | выкл.        | Output `Haratsan LLM` / `Haratsan Agent` + файлы на диске |

Кнопка **Открыть папку логов**. Подробнее: [logging-ru.md](logging-ru.md).
