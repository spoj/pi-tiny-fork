# pi-tiny-fork

A Pi package for session-owned background commands and parent-linked child Pi sessions.

## Monitor tools

- `monitor({ command })` runs the command in the current Pi cwd with Pi's configured shell, trusted project settings, and shell command prefix. It returns immediately with a run ID and log paths.
- `monitor_stop({ id })` stops a run and its process tree. Pending stdout is flushed, but an explicit stop does not send an exit wake-up.

The manager keeps stdout and stderr log files for every run, without a size cap. It passes direct file descriptors to the process and reads the stdout log about every 100 ms; there is no pipe, tee, or drain process. Stderr stays in its log and never produces messages.

Stdout is delivered in timed chunks, followed by one terminal update with status, exit information, and log paths. The first detected stdout starts a two-second timer; later writes do not reset it. Silent periods produce no updates. Chunks are not lines: a chunk can start in the middle of a line or end with a partial line. ANSI sequences and terminal controls are removed, preserving tabs and newlines. Updates use the compact form `[run-id]` followed by the sanitized chunk; relevant boundaries add `continues previous line` or `last line incomplete` inside the header.

Output is noisy-output safe:

- at most 50 KiB of raw bytes or decoded text per two-second batch;
- at most 500 visible newlines per ten seconds.

Exceeding either limit suppresses further updates, not the command. Full output remains in the logs, and completion is still reported.

All ready updates share one pending steering message. Arrivals join that message until Pi begins delivering it; later arrivals start the next batch. An idle session wakes once for the pending batch. Human steering keeps its configured delivery mode. Escape discards queued delivery as usual; future updates can wake the session again after it settles.

At most eight monitors may be active in one session. Session shutdown, reload, and replacement stop owned runs silently. Logs remain on disk.

## Child Pi sessions

The extension puts `bin/` on the session's `PATH`, which provides `pi-sub`. It accepts any `pi` arguments and records the calling session as the child's `parentSession`, so Pi shows the child under its parent:

```bash
pi-sub -p "Review src/ for correctness bugs. Report findings with file paths."
```

Run it through `monitor` to keep the parent turn available; the child's final answer arrives as monitor output. `pi-sub` writes the child's session header beside the parent session (Pi's bash tool exports the parent as `PI_SESSION_FILE`), then runs `pi --session FILE`. Outside a Pi session it runs plain `pi`. It is a POSIX shell script and needs `uuidgen`.

## Context replay

The package also contains a separate `replay` extension. It rewrites compatible assistant messages for configured model families. Configure families with `replayCompatibleModels` in `~/.pi/agent/settings.json`:

```json
{
  "replayCompatibleModels": [
    [
      "github-copilot/gpt-5.6-sol",
      "github-copilot/gpt-5.6-luna"
    ]
  ]
}
```

Families use `provider/model` IDs. Messages from another API are left to Pi's normal conversion.

## Install

```bash
pi install git:github.com/spoj/pi-tiny-fork
```

Or try the local extensions:

```bash
pi -e ./extensions/monitor.ts -e ./extensions/replay.ts
```

## Development

```bash
npm install
npm run check
```
