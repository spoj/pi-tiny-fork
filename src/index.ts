import { basename, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ForkManager, type JobSnapshot } from "./manager.ts";
import { startApi } from "./api.ts";
import { THINKING_LEVELS } from "./fork-settings.ts";

const CHILD_PROCESS = process.env.PI_FORK_CHILD === "1";
const WIDGET_KEY = "pi-tiny-fork";
const DELEGATION_SYSTEM_PROMPT = `Make every fork task self-contained. Use configured model/thinking defaults unless an override is needed. Never wait for child or run results in the parent turn. For scripted delegation, \`pi-child run -- COMMAND\` returns immediately and sends one aggregate result; its script uses \`pi-child start\` and \`pi-child result ID --wait\`. Invoke the CLI portably as \`"$PI_CHILD_NODE" "$PI_CHILD_CLI"\`; see \`pi-child --help\`.`;

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

function renderWidget(ctx: ExtensionContext, manager: ForkManager): void {
	const active = manager.list().filter((job) => job.status === "starting" || job.status === "running");
	const children = active.filter((job) => job.kind === "child").length;
	ctx.ui.setWidget(WIDGET_KEY, active.length ? [`${children} children · ${active.length - children} runs active`] : undefined);
}

function resultText(job: JobSnapshot): string {
	const output = job.lastOutput?.trim();
	const text = [
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
	const truncated = truncateHead(text);
	return truncated.content + (truncated.truncated ? "\nOutput truncated; inspect the saved files for the full result." : "");
}

function registerTools(pi: ExtensionAPI, manager: ForkManager): void {
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

export default function piTinyFork(pi: ExtensionAPI): void {
	if (CHILD_PROCESS) return;
	let shutdown: (() => Promise<void>) | undefined;

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${DELEGATION_SYSTEM_PROMPT}`,
	}));

	pi.on("session_start", async (_event, ctx) => {
		const manager = new ForkManager({
			cwd: ctx.cwd,
			sessionDir: ctx.sessionManager.getSessionDir(),
			onUpdate: () => renderWidget(ctx, manager),
			onSettled: (job) => {
				pi.sendMessage(
					{ customType: "pi-tiny-fork", content: resultText(job), display: true, details: job },
					{ deliverAs: "steer", triggerTurn: true },
				);
			},
		});
		const api = await startApi(async (request, signal) => {
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
		const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
		for (const [key, value] of Object.entries(environment)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		shutdown = async () => {
			try {
				await Promise.all([manager.shutdown(), api.close()]);
			} finally {
				for (const [key, value] of Object.entries(previous)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		};
		registerTools(pi, manager);
		renderWidget(ctx, manager);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const close = shutdown;
		shutdown = undefined;
		await close?.();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
