# Индекс кодовой базы

[English version](codebase-index.md)

Локальный индекс workspace в VS Code **workspace storage** (`ExtensionContext.storageUri`), не в `.haratsan/`. 

Агент ищет по нему через tool `codebase_search` (триграммы), без отправки всего индекса в LLM.

## Зачем

- Быстрый обзор проекта без полного `grep` / `glob`
- Ранжирование фрагментов кода для контекста агента

## Как устроено

- Индекс: workspace storage `index/<key>/manifest.json` (files, chunks, trigrams, **dirDigests**) + **`merkle.json`** (Merkle v2: узлы, chunk digests, symbol digests, метрики skip).
- Неизменённые каталоги пропускаются (content-hash + size/mtime). Неизменённые AST-чанки сохраняют digest -> без лишнего re-trigram/re-embed.
- LSP **symbol index**: `symbols.json`.
- **Outline** (`outlineEngine`, default **auto**): Tree-sitter wasm -> иначе TS `createSourceFile` / LSP / regex. Значения: `auto` \| `treesitter` \| `lsp` \| `typescript`. В `outline.json` у записей поле `source` (`treesitter` \| `typescript` \| `lsp` \| `regex`).
- **Chunking** (`chunkEngine`, default **auto**): AST через Tree-sitter (стабильные content-hash id чанков) или `lines`. Лимиты: ~400KB / ~2s parse; soft-fail.
- Грамматики: MVP в VSIX + opt-in `css`; `treeSitterLanguages` (пусто = MVP, `*` = все доступные). Reserved (kotlin/swift/...) - когда wasm в `dist/tree-sitter/`.
- Perf: пул Parser, кэш spans, LRU языков; `treeSitterUseWorker` уступает event loop.
- Метрики parse -> Activity + OTEL `index.treesitter`; skip Merkle -> `index.full`.
- `.haratsan/` не индексируется.
- При изменении файла - per-file reindex; outline/symbols с debounce.
- Результаты `codebase_search` - фрагменты (path, строки, snippet, score).
- В чате: `@file`, `@folder`, `@codebase`, `@map`, `@symbols` (см. [chat-ru.md](chat-ru.md)).

### Локальные embeddings (`localEmbeddingsMode`)

| Режим               | Поведение                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `off`               | Только remote `/embeddings` + **persistent cache** в workspace storage `vectors.json` (ключ: content-hash + model) |
| `trigram` (default) | Remote (+ cache); при сбое -> local vector если есть, иначе триграммы IndexManager                                 |
| `vector`            | Offline **локальный dense index** (feature-hashing, без сети). Обновляется на fullIndex / reindex                  |

**Стабильный remote:** документы эмбеддятся один раз на content-hash; query - каждый раз. Батчи + retry/timeout. Предпочтение чанкам IndexManager.

**Local vector:** workspace storage `vectors.json` - `local-hash` (256-d) и опционально кэш remote. Без ONNX / native deps.

Call hierarchy / «кто вызывает Y»: tool `find_references` (LSP references + definition; multi-root через `folder`/`root`; paging `limit`/`offset`; cross-lang при наличии language server).

## Использование

1. Открыть workspace - Haratsan индексирует в фоне в VS Code `storageUri` (`.haratsan/` не нужен). Чат работает во время индексации.
2. Опционально: команда **Haratsan: Инициализировать проект (.haratsan)** или slash `/init` создаёт `.haratsan/` (config, agents, skills, ...) для project overlay - не для индекса.
3. В режиме Agent вызвать `codebase_search` с `query` (символ, фраза, путь). Предпочтительнее `find_code` / `find_symbol` / `pack_context` / `similar_code`.
4. Для точного grep по строке - `grep` (пути через `glob`).
5. Семантика: `semantic_search` / `search_docs` (режимы выше).

### Eval / CI (retrieval)

Offline gate качества (без remote embeddings): `src/test/eval/retrieval.eval.ts` + pure-метрики в `src/features/index/retrievalMetrics.ts` (precision@k, recall@k, hit-rate, simpleScore) - suites trigram + local-hash vector. Smoke permissions/confirm: `src/test/eval/permissionsConfirm.eval.ts`.

```bash
npm run check-types
npm test -- --grep eval
# или: npm run test:eval
```

### Каталоги `.haratsan/` (scaffold)

При `haratsan.initProject` или `/init` создаются (если ещё нет): `agents/`, `commands/`, `plugins/`, `skills/`, `tools/`, `references/`, `plans/`, `scratch/` - плюс краткий `.haratsan/README.md` и `.gitkeep` в пустых каталогах. Существующие файлы не перезаписываются. `references.json` появляется по требованию, не при scaffold.

Подробнее про tools: [tools-ru.md](tools-ru.md).
