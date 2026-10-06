# Architecture (for development)

[Русская версия](architecture-ru.md)

## Data flows

```
Chat (webview)
  -> ChatViewProvider / ChatSession
      -> Ask: HttpLlmClient.complete
      -> Agent: AgentSession.run -> tools -> resolveWorkspacePath -> policy + gitIgnore

Comment command
  -> runCommentPipeline
      -> buildCommentMessages -> LLM -> extract -> validate -> showCommentDiff -> apply
```

## Path policy

1. `resolveAgainstFolders` / symlink check  
2. `deniedPaths` (`policy.ts`)  
3. `.gitignore` + `.haratsanignore` (`gitIgnore.ts`, cached per turn)

## Collaborative editing

- After a successful `write_file` / `apply_patch` / `apply_workspace_edit`, the session keeps a snapshot of “how the agent left it” (`AgentWriteTracker`).
- If the buffer diverges from the snapshot: full `write_file` is blocked; `apply_patch` / `apply_workspace_edit` apply on current text + confirm on conflict.
- A short user-diff for touched files is injected into the system prompt each turn.

## Sticky plan

- After approving `propose_plan`, the plan is written to **`.haratsan/plan.md`** when `planWriteToFile` is enabled; in-memory cache for the current session only.
- On extension / workspace restart the plan loads from **`.haratsan/plan.md`**, not persisted storage.
- **Clear** chat does **not** reset the plan; reset via `update_plan clear` / delete `.haratsan/plan.md`.
- Before an agent turn the file is re-read; manual diff -> system prompt; file watcher for external edits.

## Project rules (`.haratsanrules`)

- Optional markdown/text file in the workspace root: coding style, architecture, team conventions.
- Loaded at extension start and on file change; injected into agent, ask, and comment prompts (truncated at 12k chars).

## Local plugins / tools (MVP)

No npm and no arbitrary JS execution. Discovery + system-prompt catalog + tools `list_plugins` / `plugin` (+ Open on Settings Rules/Skills).

| Kind           | Path                                   | Notes                                                                    |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| Tool (file)    | `.haratsan/tools/<name>.md`            | YAML frontmatter: `name`, `description`                                  |
| Tool (package) | `.haratsan/tools/<name>/TOOL.md`       | Same idea as skills/`SKILL.md`                                           |
| Plugin         | `.haratsan/plugins/<name>/plugin.json` | Required discovery entry: `{ "name"?, "description"?, "instructions"? }` |
| Plugin body    | `.haratsan/plugins/<name>/PLUGIN.md`   | Used when `instructions` in JSON is empty                                |

The agent loads body via `plugin` (by name) or `read_file` using the catalog path. npm plugin packages - not yet.

## Config layers

- User JSON + project `.haratsan/config.json` merge into effective `HaratsanSettings` (`src/core/config/layers.ts`).
- Optional **admin policy** (`HARATSAN_ADMIN_POLICY` / `/etc/haratsan/policy.json` / `%ProgramData%/gen/policy.json`) locks a security subset - highest precedence (`src/core/config/adminPolicy.ts`).
- Precedence: defaults user UI (non-default) project **admin policy**. Remote `.well-known` / full MDM not implemented.
- Details: [settings.md](settings.md).

## Opt-in `.haratsan/` and scaffold

- Opening a folder does **not** create `.haratsan/`. Opt-in: chat banner (enable + index) or `/init`.
- `enableProject` / `ensureGenScaffold` (`src/features/project/config.ts`): `config.json` plus dirs `agents/`, `commands/`, `plugins/`, `skills/`, `tools/`, `references/`, `plans/` (`.gitkeep`, README; never overwrite).
- Details: [codebase-index.md](codebase-index.md).

## Codebase index

- Background indexing into workspace storage `index/<key>/manifest.json` (`src/features/index/`).
- Incremental by file hash; `.haratsan/` is not indexed.
- Tool `codebase_search` - trigram search over chunks.
- Context Engine (`contextEngine.ts`): ranks index hits and open editors; used by `@codebase` and mention context packing.
- Details: [codebase-index.md](codebase-index.md), mentions - [chat.md](chat.md).

## Build

- Extension host: esbuild -> `dist/extension.js`
- Webview: esbuild -> `dist/webview/`
- Tests: `yarn test` (vscode-test)
- Localization: `package.nls*.json` (commands/manifest), `l10n/bundle.l10n*.json` (host + webview UI). Webview strings are injected as `window.__HARATSAN_L10N__` from the host locale.
