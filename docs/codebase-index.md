# Codebase index

[Русская версия](codebase-index-ru.md)

Local workspace index in `.gen/index/`.

The agent searches it via the `codebase_search` tool (trigrams), without sending the whole index to the LLM.

## Why

- Fast project overview without a full `grep` / `glob` scan
- Ranking code fragments for agent context

## How it works

- The index is written to `.gen/index/manifest.json` (files, chunks, trigrams, **dirDigests** Merkle map).
- On update, ancestor directory digests are recomputed; unchanged dirs skip re-read when paths + **content-hash** match (size+mtime gate trusts the stored hash; size alone is not enough).
- LSP **symbol index** (optional cache): `.gen/index/symbols.json` via `vscode.executeDocumentSymbolProvider`. Used by `find_symbol` / `find_code` intent `symbol` and `@symbols`.
- **Outline** (no Tree-sitter / no native deps - **LSP-only** for non-JS): `.gen/index/outline.json`. TS/JS via TypeScript `createSourceFile`; other languages via `vscode.executeDocumentSymbolProvider` when available; cheap regex fallback only if LSP returns empty (`py`/`go`/`rs`/`java`/`kt`/`rb`). Also exposed via `find_symbol` (`source: outline|all`).
- `.gen/` is not indexed (same for `.git`, `node_modules` via ignore).
- On file change, only that file is reindexed (content-hash compare); outline/symbols update **per-file** (debounced), full rebuild only after a complete index pass.
- `codebase_search` results are fragments (path, lines, snippet, score).
- In chat: `@file`, `@folder`, `@codebase`, `@map`, `@symbols` inject context (see [chat.md](chat.md)).

### Local embeddings (`localEmbeddingsMode`)

| Mode                | Behavior                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `off`               | Remote `/embeddings` only, with **persistent vector cache** in `.gen/index/vectors.json` (keyed by content hash + model) |
| `trigram` (default) | Prefer remote (+ cache); on failure -> local vector if built, else IndexManager trigrams                            |
| `vector`            | Offline **local dense index** (feature-hashing embeddings, no network). Built/updated on fullIndex / reindex       |

**Stable remote:** documents are embedded once per content-hash and reused; only the query is re-embedded. Batched requests with retry/timeout. Prefer IndexManager chunks over an ad-hoc file sample.

**Local vector index:** `.gen/index/vectors.json` stores `local-hash` vectors (256-d) and optional cached remote vectors. No ONNX / native deps.

Call hierarchy / “who calls Y”: tool `find_references` (LSP reference + definition providers; multi-root via `folder`/`root`; `limit`/`offset` paging; cross-lang when a language server is available).

## Usage

1. Open a workspace and open Gen chat.
2. Click **Create config & index** (writes `.gen/config.json`, scaffold dirs, and builds `.gen/index/`). Until then Gen does not create `.gen/` on folder open. The same scaffold runs on slash `/init`.
3. In Agent mode, call `codebase_search` with `query` (symbol, phrase, path). Prefer `find_code` / `find_symbol` / `pack_context` / `similar_code` for hybrid retrieval.
4. For exact line grep - `grep` (paths via `glob`).
5. For semantic: `semantic_search` / `search_docs` (modes above).

### Eval / CI (retrieval)

Offline quality gate (no remote embeddings): `src/test/eval/retrieval.eval.ts` + pure metrics in `src/features/index/retrievalMetrics.ts` (precision@k, recall@k, hit-rate, simpleScore) - trigram + local-hash vector suites. Permissions/confirm smoke: `src/test/eval/permissionsConfirm.eval.ts`.

```bash
npm run check-types
npm test -- --grep eval
# or: npm run test:eval
```

### `.gen/` directories (scaffold)

On project enable or `/init`, these are created if missing: `agents/`, `commands/`, `plugins/`, `skills/`, `tools/`, `references/`, `plans/` - plus a short `.gen/README.md` and `.gitkeep` in empty dirs. Existing files are never overwritten. `references.json` is created on demand, not during scaffold.

More on tools: [tools.md](tools.md).
