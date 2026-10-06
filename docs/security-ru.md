# Безопасность

[English version](security.md)

## Path sandbox

Агент работает **только** внутри открытого workspace:

- запрет `..` и абсолютных путей вне папок workspace;
- после symlink путь снова проверяется на принадлежность workspace;
- относительные пути считаются от корня workspace.

## Слои запрета путей

Путь недоступен tools, если срабатывает **любой** слой:

| Слой                | Источник                   | Назначение                                                |
| ------------------- | -------------------------- | --------------------------------------------------------- |
| Workspace / symlink | встроенно                  | Не выйти за проект                                        |
| `.gitignore`        | файл в **корне** workspace | Как у git: сборка, `node_modules`, логи...                |
| `.haratsanignore`   | файл в **корне** workspace | Только для Haratsan: то, что в git есть, но агенту нельзя |
| `deniedPaths`       | настройки                  | Glob’ы пользователя (`.env`, `*.pem`, ...)                |

Матчер `.gitignore` / `.haratsanignore` кэшируется на один agent turn (пакет `ignore`, **без** spawn `git check-ignore`). Каталог `.git` всегда закрыт.

`vendor` / `target` **не** зашиты в код - их должен закрывать ignore репозитория.

### Зачем `.haratsanignore`

`.gitignore` - что не коммитить.  
`.haratsanignore` - что **нельзя читать/трогать агенту**, даже если файл в репозитории.

Пример `.haratsanignore`:

```gitignore
# секреты, которые всё же в дереве
.env.local
secrets/
*.pem
credentials.json

# шумные данные
fixtures/large/
*.dump
datasets/

# внутреннее
.haratsan/
docs/private/
```

## Маскировка секретов

В настройках **Безопасность** - JS-regexp по одному на строку.  
Совпадения в тексте, уходящем в LLM / показываемом из tools, заменяются на `[REDACTED]`.  
Пустой список - маскировки нет. Невалидная регулярка пропускается.

## Команды (`run_command`)

Без shell/pipe.

**Запрещённые бинарники** задаются в **Безопасность -> Запрещённые команды** (`deniedCommands`). По умолчанию: оболочки (`sh`, `bash`, ...), сеть (`curl`, `wget`, `ssh`, ...), разрушительное (`rm`, `chmod`, ...), контейнеры (`docker`, `kubectl`, ...). Пустой список - не блокировать по имени.

В коде по-прежнему всегда запрещены:

- package install / publish (`npm install`, ...)
- `git push` / `commit` / `reset` / ...
- eval-флаги с кодом (`node -e`, `python -c`); `gcc -c file.c` и `git -c key=value` - можно

`run_tests` / `run_command` подчиняются `approvalPolicy.shell` (и `autoApprove`) в **Settings -> Безопасность**.

## Права

См. [chat-ru.md](chat-ru.md#права-безопасность).
