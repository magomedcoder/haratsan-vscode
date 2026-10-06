# Chat and agent

[Русская версия](chat-ru.md)

Chat lives in the bottom **Haratsan** panel.

## Modes

| Mode          | How to enable     | Behavior                                                                                                                                                                              |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask**       | button / `/ask`   | Text only, no tools. Not the same as Plan.                                                                                                                                            |
| **Agent**     | button / `/agent` | Loop: LLM -> tool calls -> tool results -> LLM again (up to the iteration limit).                                                                                                     |
| **Plan**      | `/plan`           | Read/search + `propose_plan`. Edits denied. Shell: `planShellPolicy` (`ask` default - always confirm; `deny` - hidden). Plan Agent banner after approve; reminder when entering Plan. |
| **Debug**     | `/debug`          | Like Agent, focused on logs and diagnostics (`find_logs`, `read_log_tail`).                                                                                                           |
| **Design**    | `/design`         | Like Agent, focused on UI preview (`open_browser`, `fetch_page`).                                                                                                                     |
| **Multitask** | `/multitask`      | Coordinator: no direct edits; delegate via `task`.                                                                                                                                    |

Type `/` in the input for slash-command autocomplete. You can attach a question: `/debug why is auth failing?`. Active Debug/Design shows as a badge next to Ask/Agent (click to return to Agent).

## Permissions (Security)

Confirmations are controlled in **Settings -> Security** (`approvalPolicy` + `autoApprove`):

| Mode          | Behavior                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `allow`       | Run without asking                                                                                               |
| `ask`         | Confirmation card (Apply / Always / Skip / Stop)                                                                 |
| `review`      | Edits: ConfirmCard with unified diff (Accept / Reject / Always) before write; other actions: heuristic ask/allow |
| `deny`        | Blocked; reason returned to the model                                                                            |
| `autoApprove` | Treats `ask` as allow; **deny stays deny**                                                                       |

Per-action keys: `shell`, `edits`, `delete`, `web`, `outside`, `task`, `skill`. Capability toggles (terminal / file / web / ...) are coarse switches on top.

## Chat UI

- **Stop** - cancels the current request / turn (also clears a pending confirmation).
- **Clear** - clears history (prevents an in-flight request from writing messages again).
- **Confirmation** - card above the input (agent and other actions: comments, checkpoint, undo). No separate tab.
- Tool-call cards: pending / ok / denied / error, mini-diff for edits.
- Token meter: total in the header; input/output under assistant replies (if the API returns usage).

## Multiple files

If a task touches **more than one file**:

1. The agent calls `propose_plan` (title + steps with path).
2. You approve the plan.
3. The plan is written to **`.haratsan/plan.md`** and shown as a card above the input; it is injected into following turns.
4. Further edits on plan paths skip repeated `propose_plan`; progress via `update_plan` or automatically by path.
5. You can edit `.haratsan/plan.md` by hand (“Open” on the card) - on the next turn the agent sees the diff and treats the file as canonical.
6. Reset the plan by deleting `.haratsan/plan.md` or `update_plan clear`. **Clear** chat history does **not** clear the plan.

A single file can be edited without a plan.

## Checkpoint

Before mutations the agent remembers file contents. After a turn you can **Restore snapshot** - roll back to the state before that turn’s edits.

## User edits

After a successful write the agent keeps a file snapshot. If you edit the buffer by hand, the next turn sees a user-diff in the system prompt; full `write_file` over such files is blocked - only a targeted patch (with confirm on conflict).

## Editor context and mentions

In Ask and Agent, the active file / selection may be included. The agent can also read files via tools.

In the input, type `@` and choose:

| Mention                         | What is injected                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `@file path`                    | File contents                                                                           |
| `@folder path`                  | Files from a folder (capped)                                                            |
| `@code`                         | Editor selection or symbol near the cursor                                              |
| `@Docs` / `@Docs query`         | Ranked `docs/` / markdown hits (token quota)                                            |
| `@terminals`                    | Ranked terminal buffer tails (token quota; uses message text as query)                  |
| `@past` / `@past title`         | Ranked past chats / messages (token quota)                                              |
| `@agent name`                   | Body of `.haratsan/agents/{name}.md`                                                    |
| `@codebase` / `@codebase query` | Fragments from the local index + open editors                                           |
| `@map`                          | Project map outline (workspace storage map cache)                                       |
| `@symbols` / `@symbols query`   | Symbol index summary or query (workspace storage `symbols.json`)                        |
| `@git` / `@git SHA`             | Recent commits or `git show` for a SHA                                                  |
| `@branch_diff`                  | `git status` + `diff --stat`                                                            |
| `@rules`                        | AGENTS.md / `.haratsanrules`                                                            |
| `@link url`                     | Fetched page text (capped)                                                              |
| `@alias name` / `@ref:name`     | Reference from `.haratsan/references.json` (cached under `.haratsan/cache/references/`) |

Autocomplete: arrows / Tab / Enter.

### References (`@alias`)

Named pointers to a local path or git repo. Manifest: `.haratsan/references.json` (or per-alias `.haratsan/references/<alias>.json`):

```json
{
  "version": 1,
  "references": {
    "sdk": { "path": "packages/sdk", "description": "Local package" },
    "upstream": { "git": "https://github.com/org/repo.git", "branch": "main" }
  }
}
```

On first `@alias sdk` / `@ref:sdk`, content is copied (path) or shallow-cloned (git) into `.haratsan/cache/references/<alias>/`, then injected like `@folder` / `@file`.

Images: paste or drag-and-drop into Composer -> saved under `.haratsan/attachments/` with an `[image path]` marker in the message. If **visionEnabled** is on, the model also receives `image_url` parts (capped by `attachmentImageMaxBase64`).

More on the index: [codebase-index.md](codebase-index.md).

## Limits

- Paths must stay inside the workspace (see [security.md](security.md)).
- Large files: short `write_file` scaffold, then `apply_patch` in chunks (otherwise JSON tool-args may be cut by `max_tokens`).
- Agent iteration limit: 0 = unlimited; otherwise 1-40 (default 40).
