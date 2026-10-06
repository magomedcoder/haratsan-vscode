# Logging

[Русская версия](logging-ru.md)

Logging is **off** by default.

## What is written when enabled

| Channel                   | Contents                                                                   |
| ------------------------- | -------------------------------------------------------------------------- |
| Output **Haratsan LLM**   | Model requests (no body, no API key)                                       |
| Output **Haratsan Agent** | Tool audit: name, path/details (with redaction), duration, ok/error/denied |
| File `llm.log`            | Same for LLM, in extension storage                                         |
| File `agent.log`          | Same for the agent                                                         |

Disk writes are asynchronous (queue) and **do not block** HTTP requests.

## Retry

The client retries on HTTP `429` and `5xx` with backoff. User cancel and timeout are handled separately.
