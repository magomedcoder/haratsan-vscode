# Getting started

[Русская версия](getting-started-ru.md)

## Connect to an LLM

The main option is local **llama.cpp** with an OpenAI-compatible API. The same protocol works with cloud endpoints.

In **General**:

1. **Base URL** - for llama.cpp the default is `http://127.0.0.1:8080`. For the cloud, use the provider URL (for example `https://api.openai.com`).
2. **API key** - stored in VSCode `SecretStorage` (not in settings.json). For local llama.cpp it is usually not needed - leave it empty.
3. **Model** - pick from the list (loaded from the URL) or type it manually (model name/alias on the server).
4. If needed, set the key **header** and **scheme** (defaults: `Authorization` + `Bearer`).

Save the settings. If URL/model are missing, chat shows a hint and a button to open settings.

## First request

1. **Ask** mode - normal chat; selected editor code is added to context.
2. **Agent** mode - the model can call tools (read/edit files, and so on).

Switch mode in the chat header; the default is in **Chat & Agent** settings.

## Check

- In Ask, ask something simple - you should get a streaming reply (if the server supports stream).
- In Agent, ask to “read README” - a `read_file` tool-call should appear.

Next: [Chat and agent](chat.md), [Settings](settings.md), [Security](security.md).
