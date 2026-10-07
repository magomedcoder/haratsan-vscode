# Codebase index

[Русская версия](codebase-index-ru.md)

Local workspace index in VS Code **workspace storage** (`ExtensionContext.storageUri`), not under `.haratsan/`.

The agent searches it via the `codebase_search` tool (trigrams), without sending the whole index to the LLM.

## Why

- Fast project overview without a full `grep` / `glob` scan
- Ranking code fragments for agent context

## How it works

- The index is written to workspace storage `index/<key>/manifest.json` (files, chunks, trigrams, **dirDigests**) plus companion **`merkle.json`** (Merkle v2 nodes, chunk digests, symbol leaf digests, skip metrics).
- On update, ancestor digests are recomputed; unchanged dirs skip re-read when paths + **content-hash** match (size+mtime gate). Unchanged AST chunks keep digests -> skip re-trigram/re-embed work for those leaves.
- LSP **symbol index** (optional cache): `symbols.json` via `vscode.executeDocumentSymbolProvider`.
- **Outline** (`outlineEngine`): default **auto** - Tree-sitter wasm (`@vscode/tree-sitter-wasm`) when available, else TS `createSourceFile` (JS-like) / LSP / regex. Settings: `auto` \| `treesitter` \| `lsp` \| `typescript`. Entries in `outline.json` carry `source` (`treesitter` \| `typescript` \| `lsp` \| `regex`).
- **Chunking** (`chunkEngine`): default **auto** - AST spans via Tree-sitter (stable content-hash chunk ids), else line/heuristic windows (`lines`). Caps: ~400KB / ~2s parse; soft-fail -> previous engines.
- Grammars shipped in `dist/tree-sitter/*.wasm` (MVP whitelist: typescript/tsx/javascript/python/go/rust/java/cpp/c_sharp/ruby/php/bash); lazy load per language.
- Skip metrics from Merkle fullIndex -> Activity + optional OTEL (`otelEnabled`) span `index.full`.
- `.haratsan/` is not indexed (same for `.git`, `node_modules` via ignore).
- On file change, only that file is reindexed (content-hash compare); outline/symbols update **per-file** (debounced).
- `codebase_search` results are fragments (path, lines, snippet, score).
- In chat: `@file`, `@folder`, `@codebase`, `@map`, `@symbols` inject context (see [chat.md](chat.md)).

### Local embeddings (`localEmbeddingsMode`)

| Mode                | Behavior                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `off`               | Remote `/embeddings` only, with **persistent vector cache** in workspace storage `vectors.json` (keyed by content hash + model) |
| `trigram` (default) | Prefer remote (+ cache); on failure -> local vector if built, else IndexManager trigrams                                        |
| `vector`            | Offline **local dense index** (feature-hashing embeddings, no network). Built/updated on fullIndex / reindex                    |

**Stable remote:** documents are embedded once per content-hash and reused; only the query is re-embedded. Batched requests with retry/timeout. Prefer IndexManager chunks over an ad-hoc file sample.

**Local vector index:** workspace storage `vectors.json` stores `local-hash` vectors (256-d) and optional cached remote vectors. No ONNX / native deps.

Call hierarchy / “who calls Y”: tool `find_references` (LSP reference + definition providers; multi-root via `folder`/`root`; `limit`/`offset` paging; cross-lang when a language server is available).

## Usage

1. Open a workspace - Haratsan indexes in the background into VS Code `storageUri` (no `.haratsan/` required). Chat works while indexing runs.
2. Optional: command **Haratsan: Initialize project (.haratsan)** or slash `/init` creates `.haratsan/` (config, agents, skills, ...) for project overlays - not for the index.
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

### `.haratsan/` directories (scaffold)

On `haratsan.initProject` or `/init`, these are created if missing: `agents/`, `commands/`, `plugins/`, `skills/`, `tools/`, `references/`, `plans/`, `scratch/` - plus a short `.haratsan/README.md` and `.gitkeep` in empty dirs. Existing files are never overwritten. `references.json` is created on demand, not during scaffold.

More on tools: [tools.md](tools.md).
