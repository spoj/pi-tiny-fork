# pi-tiny-fork

A Pi package for fresh child sessions and session-owned background commands.

## Architecture

The package has one `ForkManager` per Pi session. It owns two job kinds:

- **children**: fresh `pi --mode rpc` sessions started by `Fork`;
- **runs**: ordinary commands started by `monitor` or `pi-child run`.

A run has `delivery: "aggregate" | "live"`. Aggregate delivery is the default. Live delivery sends bounded, timed stdout chunks to the owning Pi session and sends the terminal status in the final live message. A live run does not also send an aggregate completion message.

The manager keeps stdout and stderr log files for every run. It passes direct stdout/stderr file descriptors to the process. Live mode reads the existing stdout log file about every 100 ms; it does not use a pipe, tee, or separate drain process. Stderr is retained in its log and never produces live messages.

Live output is deliberately noisy-output safe:

- at most 50 KiB of raw stdout bytes per two seconds;
- at most 500 visible newlines per ten seconds;
- suppressed output remains in the complete stdout log.

Chunks are timed batches, not lines. A chunk can start in the middle of a line or end with a partial line. Normal live messages use the compact form `[run-id]` followed immediately by the raw chunk. Relevant boundaries add `continues previous line` or `last line incomplete` inside the header. The start response, suppression message, and final message carry log paths; suppression carries its reason and the final message carries status and exit information.

At most eight live runs may be active in one session. Session shutdown, reload, and replacement stop owned work silently.

## Fork tools

These tools are available only in the parent Pi session:

- `Fork({ task, cwd, model, thinkingLevel })` starts a fresh child and returns after startup.
- `ForkSteer({ id, prompt })` steers a running child.
- `ForkStop({ id })` stops a child, or a run and its active children.

`Fork` requires a self-contained task. `cwd`, `model`, and `thinkingLevel` are nullable; null values use `defaultForkModel` and `defaultForkThinkingLevel` from `~/.pi/agent/settings.json`. Both defaults must resolve to an exact provider/model-id and a configured thinking level. Forks use the normal Pi settings, tools, context files, and cwd, but no parent conversation.

A standalone fork sends one bounded completion message with its transcript path. Children belonging to a run stay quiet; the run owns their lifecycle and logs.

## Monitor tools

`monitor({ command })` is available in parent and child Pi processes. It runs the command in the current Pi cwd with Pi's configured shell, trusted project settings, and shell command prefix. It returns immediately with a run ID and log paths. Its stdout is delivered in timed live chunks, followed by one terminal live message.

`monitor_stop({ id })` accepts monitor run IDs and stops that run. It does not create a separate monitor registry or job kind; stopping is handled by the same manager used by the fork tools and CLI.

Use `monitor` for long-running or noisy commands when the current turn should remain available. Do not assume a chunk ends at a newline. Read the saved stdout log when exact, complete output is needed. Stderr is available in the saved stderr log.

## Script CLI

The session extension exposes `pi-child` through the parent session's `PATH`. It uses the session-local API; it never starts an untracked Pi or a separate monitor process.

```text
pi-child run [--cwd DIR] [--stream] -- COMMAND [ARGS...]
pi-child start --task TEXT [--cwd DIR] [--model provider/id] [--thinking LEVEL]
pi-child status [ID]
pi-child result ID [--wait]
pi-child steer CHILD_ID TEXT
pi-child stop ID
```

`pi-child run` starts an aggregate run by default and prints its run snapshot immediately. `--stream` selects live delivery. The CLI does not subscribe to live output; the owning Pi extension forwards live chunks as messages. `--stream` therefore has the same delivery semantics whether the command is launched from a parent script or another delegated process.

`pi-child start` uses the same fork defaults as `Fork`. A script can wait for a child with `pi-child result ID --wait`, but a parent agent turn should not wait or poll. A descendant script inherits `PI_CHILD_RUN_ID`, so its `pi-child start` joins the owning run. Nested `pi-child run` calls are rejected; execute descendant scripts normally instead.

Commands are argument lists, not shell strings. Use `PI_CHILD_NODE` and `PI_CHILD_CLI` when a script needs a portable invocation:

```python
import os
import subprocess

client = [os.environ["PI_CHILD_NODE"], os.environ["PI_CHILD_CLI"]]
subprocess.run(client + ["status"], check=True)
```

## Local API and lifecycle

The parent session opens one authenticated local API:

- Unix-domain socket on Linux/macOS, in a private directory;
- local named pipe on Windows;
- random token per session;
- no TCP listener and no global service.

The API accepts `run` delivery `aggregate` or `live`. The CLI reads only `PI_CHILD_ENDPOINT`, `PI_CHILD_TOKEN`, and the parent-provided CLI variables. Child Pi processes retain the manager and monitor tools, but do not receive the fork tools, delegation guidance, API, or `PI_CHILD_*`/PATH setup.

Session shutdown closes the API, stops all owned children and runs, restores the parent environment, and suppresses pending notifications. Transcripts and logs remain on disk for inspection.

## Install

From GitHub:

```bash
pi install git:github.com/spoj/pi-tiny-fork
```

Or try the local extension:

```bash
pi -e ./extensions/fork.ts -e ./extensions/replay.ts
```

The package manifest loads `extensions/fork.ts` and `extensions/replay.ts`. Remove the old standalone monitor package before enabling this implementation:

```bash
pi remove pi-tiny-monitor
```

Also remove any manually configured `pi-tiny-monitor` extension or project entry. Do not load both implementations in one session.

## Context replay

The package also contains a separate `replay` extension. It runs in ordinary and fork sessions and rewrites compatible assistant messages for configured model families. Configure families with `replayCompatibleModels` in `~/.pi/agent/settings.json`:

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

Families use `provider/model` IDs. Messages from another API are left to Pi's normal conversion.

## Development

```bash
npm install
npm run check
```
