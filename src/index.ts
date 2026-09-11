import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ForkManager, type ForkSnapshot } from "./manager.ts";
import { THINKING_LEVELS } from "./fork-settings.ts";

const CHILD_PROCESS = process.env.PI_FORK_CHILD === "1";
const WIDGET_KEY = "pi-tiny-fork";
const DELEGATION_SYSTEM_PROMPT = `Fork({task, cwd:null, model:null, thinkingLevel:null}) starts a fresh subagent without parent conversation history. Make the task self-contained. Keep model/thinking defaults unless an override is necessary. ForkSteer sends new direction; ForkStop cancels a child. Completion arrives asynchronously; do not wait in the parent conversation.`;

const forkTool = Type.Object({
	task: Type.String({ description: "Task sent to the forked child" }),
	cwd: Type.Union([
		Type.String({
			description:
				"Working directory for the fork process. Relative paths resolve from the parent working directory; null inherits it",
		}),
		Type.Null(),
	]),
	model: Type.Union([
		Type.String({ description: "Exact provider/model-id for the fork; null uses defaultForkModel" }),
		Type.Null(),
	]),
	thinkingLevel: Type.Union([
		StringEnum(THINKING_LEVELS, {
			description: "Thinking level for the fork; null uses defaultForkThinkingLevel",
		}),
		Type.Null(),
	]),
});

const controlTool = Type.Object({
	id: Type.String({ description: "Identifier of the fork to control" }),
	prompt: Type.String({ description: "Task or direction sent to the fork" }),
});

const stopTool = Type.Object({
	id: Type.String({ description: "Identifier of the fork to stop" }),
});

function renderWidget(ctx: ExtensionContext, manager: ForkManager): void {
	const running = manager.list().filter(isActive).length;
	ctx.ui.setWidget(WIDGET_KEY, running > 0 ? [`${running} forks running`] : undefined);
}

function resultText(fork: ForkSnapshot): string {
	const output = fork.lastOutput?.trim();
	return [
		`Fork ${fork.status}.`,
		"",
		`ID: ${fork.id}`,
		`Transcript: ${fork.transcriptPath}`,
		...(fork.pid ? [`PID: ${fork.pid}`] : []),
		fork.error ? `Error: ${fork.error}` : output ? `Result:\n${output}` : "Result: (no final response; inspect the transcript)",
	].join("\n");
}

function isActive(fork: ForkSnapshot): boolean {
	return fork.status === "starting" || fork.status === "running";
}

function registerTools(pi: ExtensionAPI, manager: ForkManager): void {
	pi.registerTool({
		name: "Fork",
		label: "Fork",
		description:
			"Starts an asynchronous subagent with a fresh conversation and a self-contained task. A model and thinking level must be selected explicitly or configured with defaultForkModel and defaultForkThinkingLevel.",
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
		description: "Sends a steering message to a running fork.",
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
		description: "Stops a fork process.",
		parameters: stopTool,
		async execute(_toolCallId, params) {
			const fork = await manager.stop(params.id);
			return { content: [{ type: "text", text: `Fork stopped.\n\nID: ${fork.id}\nTranscript: ${fork.transcriptPath}` }], details: fork };
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
	let manager: ForkManager | undefined;

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${DELEGATION_SYSTEM_PROMPT}`,
	}));

	pi.on("session_start", (_event, ctx) => {
		const current = new ForkManager({
			cwd: ctx.cwd,
			sessionDir: ctx.sessionManager.getSessionDir(),
			onUpdate: () => renderWidget(ctx, current),
			onSettled: (fork) => {
				pi.sendMessage(
					{ customType: "pi-tiny-fork", content: resultText(fork), display: true, details: fork },
					{ deliverAs: "steer", triggerTurn: true },
				);
			},
		});
		manager = current;
		registerTools(pi, current);
		renderWidget(ctx, current);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		await manager?.shutdown();
		manager = undefined;
	});
}
