# pi-tiny-fork

A tiny Pi extension for running asynchronous child sessions from a stable fork point.

## Design

The model-facing surface is intentionally fixed:

- `Fork({ task, context, cwd, model, thinkingLevel })` starts a child and returns after startup with its ID, transcript path, and PID, without waiting for completion. The required fields are `task: string`, `context: "full" | "reference" | "none"`, `cwd: string | null`, `model: string | null`, and `thinkingLevel: ThinkingLevel | null`. Null `model` and `thinkingLevel` use their dedicated `defaultFork*` settings; the fork is refused when either value is unavailable.
- `ForkSteer({ id, prompt })` steers a running child.
- `ForkStop({ id })` stops a running child.

Completed, failed, and stopped children are terminal. Their RPC process tree is terminated, and further work starts a new child with a new ID and transcript. The PID supports best-effort liveness checks, such as `kill -0 PID` on Unix; lifecycle notifications remain authoritative because operating systems can reuse PIDs. Fork processes run in their own process group, so stopping, settling, or shutting down also cleans up descendants.

There is no model listing, agent selector, wait tool, listing tool, workflow language, or model-specific transcript logic. The child is a separate `pi --mode rpc` process using the normal Pi settings and tools.

`cwd` selects an existing directory, such as a Git worktree, for the child. Relative paths are resolved against the parent working directory (`ctx.cwd`). The resolved path is used for both the child process and the forked session. When `cwd` is explicit, the delegated task also tells the child that its working directory was switched to the resolved path. For example:

```json
{
  "task": "Implement and test the feature",
  "context": "full",
  "cwd": "../feature-worktree",
  "model": null,
  "thinkingLevel": null
}
```

Fork model and thinking-level selection follows this order independently:

1. Non-null `model` or `thinkingLevel` passed to `Fork`.
2. The corresponding `defaultForkModel` or `defaultForkThinkingLevel` in `~/.pi/agent/settings.json`.
3. The fork is refused when either value is unavailable.

Forks do not fall back to model or thinking-level entries persisted in the forked session or to Pi's ordinary defaults. Both `model` and `defaultForkModel` require an exact `provider/model-id`; bare names, fuzzy matching, and thinking-level suffixes are not supported. Model IDs may contain slashes.

Children launch without `--model` or `--thinking`. Before sending the first prompt, startup awaits RPC `set_model`, then `set_thinking_level`, so Pi records changes in the child transcript. If either command fails, the fork fails without sending the prompt.

Every call explicitly chooses how to supply the parent conversation:

- `full`: copy the active parent history before the current `Fork` call into the child's new session. Use this for continuation; do not repeat inherited context in the task.
- `reference`: start a fresh conversation and include a parent-history snapshot path in the task message. The snapshot contains only the active path before the current `Fork` call, not abandoned branches or later parent activity. Use this for focused advice or review; make the task self-contained and let the child consult the snapshot if useful.
- `none`: start a fresh conversation with only the delegated task and no history snapshot. Use this for independent work with a self-contained task.

Reference snapshots are saved in `references/<child-session-id>.jsonl` under the child session directory. They remain available after the child finishes, and their path is also returned in the tool result details as `referencePath`. All modes require a persisted parent session.

Each child receives a new user message wrapped in `<delegated-task>`. The wrapper tells the child to treat any inherited history as reference material, execute only the new task, and return a concise internal handoff; an explicit `cwd` also adds a working-directory notice. Fresh conversations still use normal Pi tools, settings, and cwd-based instructions.

The extension appends the same fork guidance to the system prompt in parent and child processes, regardless of context mode. The `<delegated-task>` wrapper is model-facing guidance, not programmatic role detection: `PI_FORK_CHILD=1` marks spawned child processes and is what enforces the child tool restriction. All three tools are registered in both processes with identical schemas; a child rejects them only if the model tries to execute one. The extension does not vary its system-prompt guidance or tool schemas by role or context mode. This preserves prefix compatibility for `full` while preventing recursive delegation.

When a child settles, the parent immediately receives its status, ID, transcript path, and final text in a steering message. The parent can inspect the full transcripts with Pi's existing `read` tool. A compact human-only widget shows known child activity.

## Context replay

The package contains a separate `replay` extension. It is package-wide: it runs for ordinary Pi sessions as well as fork sessions, even when no fork tool is used. It always uses compatible mode and reads families of standard `provider/model` IDs from the top-level `replayCompatibleModels` setting in `~/.pi/agent/settings.json`:

```json
{
  "defaultForkModel": "github-copilot/gpt-5.6-luna",
  "defaultForkThinkingLevel": "xhigh",
  "replayCompatibleModels": [
    [
      "github-copilot/gpt-5.6-sol",
      "github-copilot/gpt-5.6-luna"
    ]
  ]
}
```

Each family declares replay compatibility across the listed models. Matching uses `provider/model`; compatible assistant messages are rewritten to the target's provider and model only when they use the same API as the target. Messages from another API are left untouched, so Pi's normal conversion still strips foreign reasoning signatures and tool-call metadata. Unlisted models are untouched.

When updating from three-part entries, remove the API segment from each configured ID. Model IDs can themselves contain slashes; preserve those. Three-part entries are not interpreted as a separate format.

## Install

From GitHub:

```bash
pi install git:github.com/spoj/pi-tiny-fork
```

Or run the local checkout temporarily:

```bash
pi -e ./extensions/fork.ts -e ./extensions/replay.ts
```

For normal child spawning, install the package (or configure the package in `~/.pi/agent/settings.json`) so child Pi processes load the same extension. Remove any older standalone `context-replay.ts` extension and `context-replay.json` configuration to avoid duplicate behavior.

## Development

```bash
npm install
npm run check
```

The package loads two extensions through its manifest: `extensions/fork.ts` for forks and `extensions/replay.ts` for package-wide compatible replay. Implementation lives in `src/`.
