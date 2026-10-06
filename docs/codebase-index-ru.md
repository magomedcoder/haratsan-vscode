# Индекс кодовой базы

[English version](codebase-index.md)

Локальный индекс workspace в VS Code **workspace storage** (`ExtensionContext.storageUri`), не в `.haratsan/`. 

Агент ищет по нему через tool `codebase_search` (триграммы), без отправки всего индекса в LLM.

## Зачем

- Быстрый обзор проекта без полного `grep` / `glob`
- Ранжирование фрагментов кода для контекста агента

## Как устроено

- Индекс пишется в workspace storage `index/<key>/manifest.json` (files, chunks, trigrams, **dirDigests** Merkle-карта).
- При обновлении пересчитываются digests предков; неизменённые каталоги пропускаются при совпадении путей + **content-hash** (size+mtime gate доверяет stored hash; одного size недостаточно).
- LSP **symbol index** (кэш): workspace storage `symbols.json` через `vscode.executeDocumentSymbolProvider`. Tools: `find_symbol` / `find_code` intent `symbol`, mention `@symbols`.
- **Outline** (без Tree-sitter / native deps - для non-JS **только LSP**): workspace storage `outline.json`. TS/JS через TypeScript `createSourceFile`; остальные языки через `vscode.executeDocumentSymbolProvider`, если провайдер есть; дешёвый regex fallback только если LSP пуст (`py`/`go`/`rs`/`java`/`kt`/`rb`). Также в `find_symbol` (`source: outline|all`).
- `.haratsan/` не индексируется (как и `.git`, `node_modules` через ignore).
- При изменении файла переиндексируется только он (сравнение content-hash); outline/symbols обновляются **per-file** (debounce), полный rebuild - только после full index.
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

1. Открыть workspace и чат Haratsan.
2. Нажать **Создать конфиг и индекс** (пишет `.haratsan/config.json`, scaffold-каталоги и строит индекс в VS Code `storageUri`). До этого при открытии папки `.haratsan/` не создаётся. То же scaffold делает slash `/init`.
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

При enable проекта или `/init` создаются (если ещё нет): `agents/`, `commands/`, `plugins/`, `skills/`, `tools/`, `references/`, `plans/` - плюс краткий `.haratsan/README.md` и `.gitkeep` в пустых каталогах. Существующие файлы не перезаписываются. `references.json` появляется по требованию, не при scaffold.

Подробнее про tools: [tools-ru.md](tools-ru.md).
