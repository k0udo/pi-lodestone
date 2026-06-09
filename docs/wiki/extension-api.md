# Extension API reference

This section documents how the extension hooks into Pi and how to add new tools, slash commands, or event handlers.

## Extension registration

The extension is a default export function that receives the Pi `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  // register tools, commands, hooks here
}
```

## Registering tools

Tools are registered via `pi.registerTool`. Each tool gets a name, parameters (defined with TypeBox), and an `execute` function.

```ts
pi.registerTool({
  name: "my-tool",
  label: "My Tool",
  description: "What this tool does.",
  promptSnippet: "Short description for the agent prompt",
  parameters: Type.Object({
    arg1: Type.String({ description: "Description of arg1" }),
    arg2: Type.Optional(Type.Number({ description: "Optional number" })),
  }),
  async execute(id, params, signal, update, ctx) {
    // do work
    return {
      content: [{ type: "text", text: "Result" }],
      details: { arg1: params.arg1 },
    };
  },
});
```

The `ctx` object provides access to the current session, cwd, and UI. Return `{ content, details }` as the tool result.

## Registering slash commands

Slash commands are registered via `pi.registerSlashCommand`:

```ts
pi.registerSlashCommand({
  name: "/my-command",
  description: "What this command does.",
  promptSnippet: "Short description for the agent prompt",
  async execute(args, ctx) {
    // handle subcommands via args parsing
    ctx.ui.notify("Result", "success");
    // or set a widget for richer output:
    ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });
  },
});
```

The existing `/memory` command uses a single handler that dispatches on subcommand strings. This pattern works well when you have many related subcommands.

## Event hooks

Pi exposes lifecycle events. The extension subscribes via `pi.on`:

| Event | When it fires | Typical use |
|---|---|---|
| `session_start` | New Pi session begins | Initialize store, show status |
| `before_agent_start` | Before each agent turn | Search and inject memories |
| `context` | After injection, before agent runs | Prepend memories to user message |
| `agent_end` | After agent completes a turn | Optional turn capture, cleanup |

```ts
pi.on("before_agent_start", (event, ctx) => {
  // event.prompt contains the user prompt
  // event.systemPrompt contains the system prompt
  // return { systemPrompt: "..." } to modify the system prompt
  // or set pending preamble for context hook
});

pi.on("context", (event) => {
  // event.messages contains the current message list
  // return { messages: [...] } to modify messages
});
```

The `context` hook is how memories get injected into the prompt. The default placement is on the latest user message (`PI_MEMORY_INJECT_PLACEMENT=user`) to keep the system prompt stable for prefix cache reuse.

## Adding a new slash command subcommand

To add a subcommand to `/memory`:

1. Add a new `if (sub === "my-sub")` branch in the slash handler.
2. Parse arguments from the `rest` array.
3. Use `store` for read/write operations.
4. Use `ctx.ui.notify()` or `ctx.ui.setWidget()` for feedback.
5. Optionally call `memoryCheckpoint()` for git integration.

## Adding a new tool

To add a new tool:

1. Add a `pi.registerTool()` call in the extension function.
2. Define parameters with TypeBox.
3. Implement the `execute` function with `ctx` access.
4. Use `store` for data operations.
5. Use `bumpUse()` if the tool should update usage counters (requires `PI_MEMORY_UPDATE_USAGE_COUNTERS`).

## Utilities available in index.ts

| Function | Purpose |
|---|---|
| `search(query, options)` | Query the store with scoring |
| `sanitize(text)` | Strip private blocks, mask secrets, truncate |
| `makeId()` | Generate a short random ID |
| `memoryCheckpoint(msg)` | Run `git add/commit/push` if initialized |
| `writeVaultNote(decision, folder)` | Export a decision as a vault note |
| `compactTurnText(messages)` | Extract user/assistant text from session messages |
| `decisionStatementFromTurn(text)` | Heuristic extraction of decision-like statements |
| `findPotentialDuplicate(title, text, all)` | Check for near-duplicate decisions |

## Environment variable access

All configuration comes from environment variables at module load time:

```ts
const AUTO_INJECT = (process.env.PI_MEMORY_AUTO_INJECT ?? "true") !== "false";
```

Defaults are set inline. Adding a new option means adding a new constant with a sensible default, then documenting it in `skills/lodestone/README.md`.
