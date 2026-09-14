import { basename, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, type TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	getShellConfig,
	SettingsManager,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ForkManager, type JobSnapshot, type RunSnapshot } from "./manager.ts";
import type { LiveChunk } from "./live-output.ts";
import { startApi, type ChildRequest } from "./api.ts";
import { THINKING_LEVELS } from "./fork-settings.ts";

const CHILD_PROCESS = process.env.PI_FORK_CHILD === "1";
const WIDGET_KEY = "pi-tiny-fork";
const DELEGATION_SYSTEM_PROMPT = `Make every fork task self-contained. Use configured model/thinking defaults unless an override is needed. Never wait for child or run results in the parent turn. For scripted delegation, \`pi-child run -- COMMAND\` returns immediately and sends one aggregate result; its script uses \`pi-child start\` and \`pi-child result ID --wait\`. Use \`pi-child run --stream -- COMMAND\` when timed stdout updates should be delivered to the parent. Invoke the CLI portably as \`"$PI_CHILD_NODE" "$PI_CHILD_CLI"\`; see \`pi-child --help\`.`;

const forkTool = Type.Object({
	task: Type.String({ description: "Self-contained task for the child" }),
	cwd: Type.Union([
		Type.String({ description: "Child working directory; relative paths resolve from parent cwd, null inherits it" }),
		Type.Null(),
	]),
	model: Type.Union([
		Type.String({ description: "Exact provider/model-id, or null for defaultForkModel" }),
		Type.Null(),
	]),
	thinkingLevel: Type.Union([
		StringEnum(THINKING_LEVELS, {
			description: "Thinking level, or null for defaultForkThinkingLevel",
		}),
		Type.Null(),
	]),
}, { additionalProperties: false });

const controlTool = Type.Object({
	id: Type.String({ description: "Running child ID" }),
	prompt: Type.String({ description: "Steering message" }),
});

const stopTool = Type.Object({
	id: Type.String({ description: "Child or run ID" }),
});

const monitorTool = Type.Object({
	command: Type.String({ minLength: 1, description: "Shell command to run in the background" }),
});

const monitorStopTool = Type.Object({
	id: Type.String({ minLength: 1, description: "Running monitor ID" }),
});

function renderWidget(ctx: ExtensionContext, manager: ForkManager): void {
	const active = manager.list().filter((job) => job.status === "starting" || job.status === "running");
	const children = active.filter((job) => job.kind === "child").length;
	ctx.ui.setWidget(WIDGET_KEY, active.length ? [`${children} children · ${active.length - children} runs active`] : undefined);
}

function resultText(job: JobSnapshot): string {
	const output = job.lastOutput?.trim();
	const lines = [
		`${job.kind === "child" ? "Fork" : "Run"} ${job.status}.`,
		"",
		`ID: ${job.id}`,
		...(job.kind === "child" ? [`Transcript: ${job.transcriptPath}`] : [
			`Stdout: ${job.stdoutPath}`, `Stderr: ${job.stderrPath}`, `Children: ${job.childIds.join(", ") || "none"}`,
		]),
		...(job.error ? [`Error: ${job.error}`] : []),
		output ? `Result:\n${output}` : "Result: (no final output; inspect the saved files)",
		...(job.kind === "run" && job.outputTruncated ? ["Output truncated; full output is in the saved logs."] : []),
	].join("\n");
	const truncated = truncateHead(lines);
	return truncated.content + (truncated.truncated ? "\nOutput truncated; inspect the saved files for the full result." : "");
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

function registerForkTools(pi: ExtensionAPI, manager: ForkManager): void {
	pi.registerTool({
		name: "Fork",
		label: "Fork",
		description: "Starts a background child without parent conversation context.",
		parameters: forkTool,
		async execute(_toolCallId, params) {
			const fork = await manager.start({
				task: params.task,
				cwd: params.cwd ?? undefined,
				model: params.model ?? undefined,
				thinkingLevel: params.thinkingLevel ?? undefined,
			});
			return {
				content: [{
					type: "text",
					text: `Fork started.\n\nID: ${fork.id}\nTranscript: ${fork.transcriptPath}\nPID: ${fork.pid}`,
				}],
				details: fork,
			};
		},
		renderCall(params, theme) {
			const options = [
				`cwd: ${params.cwd ?? "inherited"}`,
				`model: ${params.model ?? "default"}`,
				`thinking: ${params.thinkingLevel ?? "default"}`,
			];
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Fork"))} ${theme.fg("toolOutput", params.task ?? "")}\n${theme.fg("muted", options.join(" · "))}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "ForkSteer",
		label: "Fork Steer",
		description: "Steers a running child.",
		parameters: controlTool,
		async execute(_toolCallId, params) {
			const fork = await manager.steer(params.id, params.prompt);
			return { content: [{ type: "text", text: `Steering sent.\n\nID: ${fork.id}\nTranscript: ${fork.transcriptPath}` }], details: fork };
		},
		renderCall(params, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Fork Steer"))} ${theme.fg("accent", params.id ?? "")}\n${theme.fg("toolOutput", params.prompt ?? "")}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "ForkStop",
		label: "Fork Stop",
		description: "Stops a child, or a run and its active children.",
		parameters: stopTool,
		async execute(_toolCallId, params) {
			const job = await manager.stop(params.id);
			return { content: [{ type: "text", text: `Stopped ${job.id}.` }], details: job };
		},
		renderCall(params, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Fork Stop"))} ${theme.fg("accent", params.id ?? "")}`,
				0,
				0,
			);
		},
	});
}

function registerMonitorTools(pi: ExtensionAPI, manager: ForkManager): void {
	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: "Runs a background shell command and delivers bounded stdout updates while it runs, then a final status.",
		promptSnippet: "Run a background shell command with live stdout updates",
		promptGuidelines: [
			"Use monitor for long-running or noisy shell commands when the current turn should remain available.",
			"Monitor output arrives in timed chunks; chunk boundaries are not newline boundaries. Use the continuation and incomplete-line headers, and read the saved stdout log for complete output.",
			"Monitor streams stdout only. Stderr is retained in the saved stderr log and does not wake the agent.",
		],
		parameters: monitorTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			const shell = getShellConfig(settings.getShellPath());
			const prefix = settings.getShellCommandPrefix();
			const command = prefix ? `${prefix}\n${params.command}` : params.command;
			const run = await manager.run(
				shell.commandTransport === "stdin" ? [shell.shell, ...shell.args] : [shell.shell, ...shell.args, command],
				{
					cwd: ctx.cwd,
					delivery: "live",
					...(shell.commandTransport === "stdin" ? { stdin: command } : {}),
				},
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
			const job = manager.status(params.id);
			if (job.kind !== "run") throw new Error(`${params.id} is not a monitor run`);
			const stopped = await manager.stop(params.id);
			return { content: [{ type: "text", text: `Monitor stopped.\n\nID: ${stopped.id}` }], details: stopped };
		},
	});
}

export default function piTinyFork(pi: ExtensionAPI): void {
	let shutdown: (() => Promise<void>) | undefined;
	let pending: { content: TextContent[]; details: JobSnapshot[] } | undefined;

	function notify(text: string, job?: JobSnapshot): void {
		const queued = pending !== undefined;
		pending ??= { content: [], details: [] };
		// Pi retains these arrays until message_start; later arrivals join the same queued message.
		pending.content.push({ type: "text", text });
		if (job) pending.details.push(job);
		if (!queued) {
			pi.sendMessage(
				{ customType: "pi-tiny-fork", ...pending, display: true },
				{ deliverAs: "steer", triggerTurn: true },
			);
		}
	}

	pi.on("message_start", ({ message }) => {
		if (message.role === "custom" && message.customType === "pi-tiny-fork" && message.content === pending?.content) {
			pending = undefined;
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) pending = undefined;
	});

	if (!CHILD_PROCESS) {
		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${DELEGATION_SYSTEM_PROMPT}`,
		}));
	}

	pi.on("session_start", async (_event, ctx) => {
		const manager = new ForkManager({
			cwd: ctx.cwd,
			sessionDir: ctx.sessionManager.getSessionDir(),
			onUpdate: () => renderWidget(ctx, manager),
			onOutput: (run, chunk) => notify(liveText(run, chunk)),
			onSettled: (job) => notify(resultText(job), job),
		});

		let api: Awaited<ReturnType<typeof startApi>> | undefined;
		let previous: Record<string, string | undefined> | undefined;
		if (!CHILD_PROCESS) {
			api = await startApi(async (request: ChildRequest, signal) => {
				switch (request.op) {
					case "start": return manager.start(request);
					case "run": return manager.run(request.argv, request);
					case "status": return request.id === undefined ? manager.list() : manager.status(request.id);
					case "result": return manager.result(request.id, request.wait, signal);
					case "steer": return manager.steer(request.id, request.prompt);
					case "stop": return manager.stop(request.id);
				}
			});
			const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
			const executable = basename(process.execPath).replace(/\.exe$/i, "");
			const environment: Record<string, string | undefined> = {
				PI_CHILD_ENDPOINT: api.endpoint,
				PI_CHILD_TOKEN: api.token,
				PI_CHILD_RUN_ID: undefined,
				PI_CHILD_CLI: fileURLToPath(new URL("../bin/pi-child.mjs", import.meta.url)),
				PI_CHILD_NODE: executable === "node" || executable === "bun" ? process.execPath : "node",
				[pathKey]: `${fileURLToPath(new URL("../bin", import.meta.url))}${delimiter}${process.env[pathKey] ?? ""}`,
			};
			previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
			for (const [key, value] of Object.entries(environment)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		shutdown = async () => {
			try {
				await Promise.all([manager.shutdown(), api?.close()]);
			} finally {
				if (previous) {
					for (const [key, value] of Object.entries(previous)) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
				}
			}
		};
		if (!CHILD_PROCESS) registerForkTools(pi, manager);
		registerMonitorTools(pi, manager);
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
