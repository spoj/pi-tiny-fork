# pi-tiny-fork

A tiny Pi extension for running asynchronous child sessions with fresh conversations.

## Design

The model-facing surface is intentionally fixed:

- `Fork({ task, cwd, model, thinkingLevel })` starts a fresh child and returns after startup with its ID, transcript path, and PID, without waiting for completion. The required fields are `task: string`, `cwd: string | null`, `model: string | null`, and `thinkingLevel: ThinkingLevel | null`. Null `model` and `thinkingLevel` use their dedicated `defaultFork*` settings; the fork is refused when either value is unavailable.
- `ForkSteer({ id, prompt })` steers a running child.
- `ForkStop({ id })` stops a running child, or a script run and its outstanding children.

Completed, failed, and stopped children are terminal. Their RPC process tree is terminated, and further work starts a new child with a new ID and transcript. The PID supports best-effort liveness checks, such as `kill -0 PID` on Unix; lifecycle notifications remain authoritative because operating systems can reuse PIDs. Cleanup terminates process groups on Linux/macOS and uses process-tree termination on Windows.

There is no model listing, agent selector, wait tool, listing tool, workflow language, or model-specific transcript logic. The child is a separate `pi --mode rpc` process using the normal Pi settings and tools.

`cwd` selects an existing directory, such as a Git worktree, for the child. Relative paths are resolved against the parent working directory. The resolved path is used for both the child process and its session. For example:

```json
{
  "task": "Implement and test the feature",
  "cwd": "../feature-worktree",
  "model": null,
  "thinkingLevel": null
}
```

Fork model and thinking-level selection follows this order independently:

1. Non-null `model` or `thinkingLevel` passed to `Fork`.
2. The corresponding `defaultForkModel` or `defaultForkThinkingLevel` in `~/.pi/agent/settings.json`.
3. The fork is refused when either value is unavailable.

Forks do not fall back to Pi's ordinary model or thinking-level defaults. Both `model` and `defaultForkModel` require an exact `provider/model-id`; bare names, fuzzy matching, and thinking-level suffixes are not supported. Model IDs may contain slashes.

Children launch without `--model` or `--thinking`. Before sending the first prompt, startup awaits RPC `set_model`, then `set_thinking_level`, so Pi records changes in the child transcript. If either command fails, the fork fails without sending the prompt.

Every child starts with only its delegated task and normal Pi tools, settings, and cwd-based instructions. Make the task self-contained: no parent conversation or snapshot is supplied. A persisted parent session is not required.

The task is wrapped in `<delegated-task>` with final-report guidance. Spawned agents have `PI_FORK_CHILD=1`; the extension does not register orchestration tools or hooks in those processes. Children cannot recursively delegate.

When a standalone child settles, the parent receives its status, ID, transcript path, and final text in a steering message. Children belonging to a script run stay quiet; only the run's aggregate completion notifies the parent. A compact human-only widget shows active children and runs.

## Script CLI

Tools and scripts use the same session-owned manager and the same Pi child implementation. The extension adds `pi-child` to the parent session's `PATH`; it does not modify your login shell. The CLI needs Node.js, which is already present for npm installations of Pi.

| Command | Behavior |
| --- | --- |
| `pi-child run [--cwd DIR] -- COMMAND [ARGS...]` | Launch a tracked background script and immediately return its run ID |
| `pi-child start --task TEXT [--cwd DIR] [--model provider/id] [--thinking LEVEL]` | Launch a fresh child and return its ID after startup |
| `pi-child status [ID]` | Inspect a child/run, or list everything tracked by this session |
| `pi-child result ID [--wait]` | Get a final child/run result; optionally wait for completion |
| `pi-child steer CHILD_ID TEXT` | Send direction to a running child |
| `pi-child stop ID` | Stop a child, or a run and all its outstanding work |

Successful commands print JSON to stdout. Command errors print to stderr and exit nonzero. Retrieving a failed or stopped result is a successful command: inspect its `status` field. Without `--wait`, `result` fails if work is still running. A disconnected waiter does not cancel the work.

`start` uses the same model/thinking defaults as `Fork`. Its default cwd is the owning run's cwd, or the parent session's cwd outside a run. Relative `--cwd` paths resolve against that default. A run's cwd resolves against the parent session's cwd. Commands are executable argument lists, not shell strings; explicitly invoke a shell if you need shell syntax.

### Runs and ownership

A run is one script execution and the managed children it starts. Ordinary descendant scripts automatically inherit `PI_CHILD_RUN_ID`; their `pi-child start` calls join the same run. No batch flag or process-ancestry lookup is needed. Nested `pi-child run` calls are rejected: execute descendant scripts normally instead.

- Inside a run, children remain individually inspectable, steerable, and stoppable, but do not send parent completion messages.
- Outside a run, `start` creates a standalone child with an individual completion notification.
- Stopping a run closes it first, stops its script process tree and all its unfinished managed children, then reports completion. Further starts using that run ID fail.
- Script exit also closes the run and stops unfinished children, even after a successful exit. Scripts must wait for the results they want to keep working on.
- The script's exit code determines the run's status. The script decides how to handle child failures.
- Raw `pi` processes launched by scripts are not tracked. Use `pi-child start`.

The run's stdout becomes its aggregate result; stderr is included on failure. Result previews retain at most the last 50 KiB / 2,000 lines of each stream. Full logs remain under `runs/<run-id>/` in the session directory and their paths are returned with the result. Parent notifications are also truncated; child transcripts and run logs remain readable with Pi's existing tools.

### Example: concurrent reviews

Configure `defaultForkModel` and `defaultForkThinkingLevel`, then run from this checkout:

```sh
pi-child run -- python examples/review.py
```

Use your installed Python command (`python3` if needed). The example starts two children concurrently, waits inside the background script, and prints one combined JSON result. The parent stays available for user messages throughout. It needs no cleanup traps: the manager owns the run and its children.

Python/JavaScript scripts can invoke the CLI portably as an argument list using `PI_CHILD_NODE` and `PI_CHILD_CLI`, avoiding Windows `.cmd` resolution and shell quoting. For example:

```python
client = [os.environ["PI_CHILD_NODE"], os.environ["PI_CHILD_CLI"]]
result = subprocess.run(client + ["status"], check=True, capture_output=True, encoding="utf-8")
```

Only background scripts should use `result --wait`; waiting in a foreground parent tool call blocks that conversation turn.

### Local connection and lifecycle

The extension opens one local API at session startup:

- Linux/macOS: Unix-domain socket in a private directory.
- Windows: local named pipe.
- Both: a random per-session authentication token. No TCP listener or global service.

The CLI reads `PI_CHILD_ENDPOINT` and `PI_CHILD_TOKEN` from the environment. Missing credentials, a wrong token, or a closed connection is an error; the CLI never starts an untracked Pi as a fallback. Scripts do not implement socket/pipe handling. Agent child processes do not inherit any `PI_CHILD_*` variables and cannot use the orchestration CLI recursively.

Session shutdown, reload, or replacement stops all outstanding runs and children, closes the API, and restores the environment. IDs and live tracking last only for that session runtime; transcripts and logs persist. These are lifecycle controls, not a sandbox: scripts and agents run with your user permissions.

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
