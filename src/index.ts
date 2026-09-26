import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	getShellConfig,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MonitorManager, type RunSnapshot } from "./manager.ts";
import type { LiveChunk } from "./live-output.ts";

const WIDGET_KEY = "pi-tiny-fork";

const monitorTool = Type.Object({
	command: Type.String({ minLength: 1, description: "Shell command to run in the background" }),
});

const monitorStopTool = Type.Object({
	id: Type.String({ minLength: 1, description: "Running monitor ID" }),
});

function renderWidget(ctx: ExtensionContext, manager: MonitorManager): void {
	const active = manager.list().filter((run) => run.status === "starting" || run.status === "running").length;
	ctx.ui.setWidget(WIDGET_KEY, active ? [`${active} monitors active`] : undefined);
}

function liveText(run: RunSnapshot, chunk: LiveChunk & { streamEnded?: boolean }): string {
	const flags = [
		chunk.startsWithContinuation ? "continues previous line" : undefined,
		chunk.endsWithPartialLine ? "last line incomplete" : undefined,
	].filter((flag): flag is string => flag !== undefined);
	if (chunk.suppressed) {
		flags.push(`suppressed: ${chunk.text}`, `stdout log: ${run.stdoutPath}`);
	}
	if (chunk.streamEnded) {
		flags.push(`status: ${run.status}`);
		if (run.exitCode !== undefined) flags.push(`exit code: ${run.exitCode}`);
		if (run.signal !== undefined) flags.push(`signal: ${run.signal}`);
		flags.push(`stdout: ${run.stdoutPath}`, `stderr: ${run.stderrPath}`);
	}
	return `[${[run.id, ...flags].join(" · ")}]${chunk.suppressed ? "" : `\n${chunk.text}`}`;
}

function registerTools(pi: ExtensionAPI, manager: MonitorManager): void {
	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: "Runs a background shell command and delivers bounded stdout updates while it runs, then a final status.",
		promptSnippet: "Run a background shell command with live stdout updates",
		promptGuidelines: [
			"Use monitor for long-running or noisy shell commands when the current turn should remain available.",
			"Monitor output arrives in timed chunks; chunk boundaries are not newline boundaries. Use the continuation and incomplete-line headers, and read the saved stdout log for complete output.",
			"Monitor streams stdout only. Stderr is retained in the saved stderr log and does not wake the agent.",
			"To delegate to a child Pi agent, monitor `pi-sub -p \"TASK\"`; it accepts pi flags and records this session as the child's parent.",
		],
		parameters: monitorTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			const shell = getShellConfig(settings.getShellPath());
			const prefix = settings.getShellCommandPrefix();
			const command = prefix ? `${prefix}\n${params.command}` : params.command;
			const run = await manager.run(
				shell.commandTransport === "stdin" ? [shell.shell, ...shell.args] : [shell.shell, ...shell.args, command],
				{ cwd: ctx.cwd, ...(shell.commandTransport === "stdin" ? { stdin: command } : {}) },
			);
			return {
				content: [{ type: "text", text: `Monitor started.\n\nID: ${run.id}\nStdout: ${run.stdoutPath}\nStderr: ${run.stderrPath}` }],
				details: run,
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Monitor Stop",
		description: "Stops a running monitor by ID.",
		parameters: monitorStopTool,
		async execute(_toolCallId, params) {
			const stopped = await manager.stop(params.id);
			return { content: [{ type: "text", text: `Monitor stopped.\n\nID: ${stopped.id}` }], details: stopped };
		},
	});
}

export default function piTinyFork(pi: ExtensionAPI): void {
	let shutdown: (() => Promise<void>) | undefined;
	let pending: TextContent[] | undefined;

	function notify(text: string): void {
		const queued = pending !== undefined;
		pending ??= [];
		// Pi retains this array until message_start; later arrivals join the same queued message.
		pending.push({ type: "text", text });
		if (!queued) {
			pi.sendMessage(
				{ customType: "pi-tiny-fork", content: pending, display: true },
				{ deliverAs: "steer", triggerTurn: true },
			);
		}
	}

	pi.on("message_start", ({ message }) => {
		if (message.role === "custom" && message.customType === "pi-tiny-fork" && message.content === pending) {
			pending = undefined;
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) pending = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		const manager = new MonitorManager({
			sessionDir: ctx.sessionManager.getSessionDir(),
			onUpdate: () => renderWidget(ctx, manager),
			onOutput: (run, chunk) => notify(liveText(run, chunk)),
		});

		const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		const previousPath = process.env[pathKey];
		process.env[pathKey] = `${fileURLToPath(new URL("../bin", import.meta.url))}${delimiter}${previousPath ?? ""}`;

		shutdown = async () => {
			try {
				await manager.shutdown();
			} finally {
				if (previousPath === undefined) delete process.env[pathKey];
				else process.env[pathKey] = previousPath;
			}
		};
		registerTools(pi, manager);
		renderWidget(ctx, manager);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const close = shutdown;
		shutdown = undefined;
		pending = undefined;
		await close?.();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
