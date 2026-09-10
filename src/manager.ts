import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createForkSession, delegatedTask, type ForkContext } from "./fork.ts";
import { RpcChild, type ChildEventListener, type ChildExit } from "./rpc.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ForkLaunchOptions } from "./fork-settings.ts";

export type ForkStatus = "starting" | "running" | "completed" | "failed" | "stopped";

export type ForkSnapshot = {
	id: string;
	transcriptPath: string;
	referencePath?: string;
	pid?: number;
	status: ForkStatus;
	activity?: string;
	turns: number;
	lastOutput?: string;
	error?: string;
};

type ForkRecord = ForkSnapshot & {
	cwd: string;
	cwdExplicit: boolean;
	launchOptions: ForkLaunchOptions;
	child?: RpcChild;
	cleanup?: Promise<void>;
	lastStopReason?: string;
	stopRequested: boolean;
	settled: boolean;
	operation: Promise<void>;
};

type ManagerOptions = {
	onUpdate: () => void;
	onSettled: (fork: ForkSnapshot) => void;
};

function newId(existing: Map<string, ForkRecord>): string {
	let id = "";
	do {
		id = `fork-${randomUUID().slice(0, 8)}`;
	} while (existing.has(id));
	return id;
}

function textFromAssistant(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
	return candidate.content
		.filter((block): block is { type: "text"; text: string } => {
			if (!block || typeof block !== "object") return false;
			const value = block as { type?: unknown; text?: unknown };
			return value.type === "text" && typeof value.text === "string";
		})
		.map((block) => block.text)
		.join("");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ForkManager {
	private readonly forks = new Map<string, ForkRecord>();
	private readonly starts = new Set<Promise<unknown>>();
	private shuttingDown = false;

	constructor(private readonly options: ManagerOptions) {}

	list(): ForkSnapshot[] {
		return Array.from(this.forks.values()).map((fork) => this.snapshot(fork));
	}

	async start(
		ctx: ExtensionContext,
		prompt: string,
		context: ForkContext,
		launchOptions: ForkLaunchOptions,
		cwd?: string,
	): Promise<ForkSnapshot> {
		if (!launchOptions.model?.trim()) {
			throw new Error(
				"Fork requires a model. First check which models are available, then ask the user to choose one; do not assume a model. The user can also configure defaultForkModel.",
			);
		}
		if (!launchOptions.thinkingLevel) {
			throw new Error(
				"Fork requires a thinking level: ask the user to choose one or configure defaultForkThinkingLevel; do not assume one.",
			);
		}
		if (this.shuttingDown) throw new Error("Fork manager is shutting down");

		const cwdExplicit = cwd !== undefined;
		const forkCwd = cwdExplicit ? resolve(ctx.cwd, cwd) : ctx.cwd;
		const id = newId(this.forks);
		const files = createForkSession(ctx.sessionManager, context, cwdExplicit ? forkCwd : undefined, prompt);
		const fork: ForkRecord = {
			id,
			...files,
			cwd: forkCwd,
			cwdExplicit,
			launchOptions,
			status: "starting",
			turns: 0,
			stopRequested: false,
			settled: false,
			operation: Promise.resolve(),
		};
		this.forks.set(id, fork);
		this.options.onUpdate();

		fork.settled = false;
		const operation = this.launch(fork, prompt);
		this.starts.add(operation);
		try {
			return await operation;
		} finally {
			this.starts.delete(operation);
		}
	}

	async steer(id: string, prompt: string): Promise<ForkSnapshot> {
		const fork = this.require(id);
		return this.enqueue(fork, async () => {
			if (fork.status !== "running" || !fork.child?.isAlive()) {
				throw new Error(`${id} is not running; start a new fork to continue the work`);
			}
			await fork.child.steer(prompt);
			return this.snapshot(fork);
		});
	}

	async stop(id: string): Promise<ForkSnapshot> {
		const fork = this.require(id);
		return this.enqueue(fork, async () => {
			if (fork.status !== "starting" && fork.status !== "running") {
				throw new Error(`${id} is not running`);
			}
			fork.stopRequested = true;
			if (fork.child?.isAlive()) void fork.child.abort().catch(() => undefined);
			if (fork.child) {
				fork.cleanup ??= fork.child.stop();
				await fork.cleanup;
			}
			fork.status = "stopped";
			fork.activity = undefined;
			this.options.onUpdate();
			if (!this.shuttingDown) this.settle(fork);
			return this.snapshot(fork);
		});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await Promise.all([
			...Array.from(this.forks.values()).map(async (fork) => {
				fork.stopRequested = true;
				fork.cleanup ??= fork.child ? fork.child.stop() : Promise.resolve();
				await fork.cleanup;
			}),
			...Array.from(this.forks.values(), (fork) => fork.operation),
			...Array.from(this.starts, (start) => start.catch(() => undefined)),
		]);
	}

	private async launch(fork: ForkRecord, prompt: string): Promise<ForkSnapshot> {
		try {
			await this.startProcess(fork);
			if (this.shuttingDown) throw new Error("Fork manager is shutting down");
			fork.status = "running";
			this.options.onUpdate();
			await fork.child!.prompt(delegatedTask(prompt, fork.cwdExplicit ? fork.cwd : undefined, fork.referencePath));
			return this.snapshot(fork);
		} catch (error) {
			fork.stopRequested = true;
			if (fork.child) {
				fork.cleanup ??= fork.child.stop().catch(() => undefined);
				await fork.cleanup;
			}
			fork.stopRequested = false;
			this.fail(fork, errorText(error));
			if (!this.shuttingDown) this.settle(fork);
			throw new Error(`Could not start ${fork.id}: ${errorText(error)}`);
		}
	}

	private async startProcess(fork: ForkRecord): Promise<void> {
		const child = new RpcChild(fork.cwd, fork.transcriptPath, fork.launchOptions);
		fork.child = child;
		child.onEvent(this.eventListener(fork));
		child.onExit((exit) => this.handleExit(fork, child, exit));
		await child.start();
		fork.pid = child.getPid();
	}

	private eventListener(fork: ForkRecord): ChildEventListener {
		return (event) => {
			if (this.shuttingDown) return;
			switch (event.type) {
				case "turn_start":
					fork.turns++;
					fork.status = "running";
					break;
				case "tool_execution_start":
					fork.activity = event.toolName;
					break;
				case "tool_execution_end":
					if (fork.activity === event.toolName) fork.activity = undefined;
					break;
				case "message_end":
					if (event.message.role === "assistant") {
						fork.lastOutput = textFromAssistant(event.message) || undefined;
						fork.lastStopReason = event.message.stopReason;
						fork.error = event.message.errorMessage;
					}
					break;
				case "agent_settled":
					if (!fork.stopRequested && !fork.settled) {
						if (fork.lastStopReason === "error" || fork.lastStopReason === "aborted") {
							fork.status = "failed";
							fork.error = fork.error ?? "Fork stopped with an error";
						} else {
							fork.status = "completed";
						}
						fork.activity = undefined;
						this.settle(fork);
					}
					break;
			}
			this.options.onUpdate();
		};
	}

	private handleExit(fork: ForkRecord, child: RpcChild, exit: ChildExit): void {
		if (fork.child !== child || this.shuttingDown || fork.stopRequested) return;
		if (fork.status === "completed" || fork.status === "failed") return;
		fork.status = "failed";
		fork.activity = undefined;
		fork.error = child.getStderr().trim() || `Process exited with ${exit.code ?? exit.signal ?? "no status"}`;
		this.options.onUpdate();
		this.settle(fork);
	}

	private settle(fork: ForkRecord): void {
		if (fork.settled) return;
		fork.settled = true;
		fork.stopRequested = true;
		if (fork.child && !fork.cleanup) fork.cleanup = fork.child.stop().catch(() => undefined);
		this.options.onSettled(this.snapshot(fork));
	}

	private fail(fork: ForkRecord, message: string): void {
		fork.status = "failed";
		fork.activity = undefined;
		fork.error = message;
		this.options.onUpdate();
	}

	private require(id: string): ForkRecord {
		const fork = this.forks.get(id);
		if (!fork) throw new Error(`Unknown fork: ${id}`);
		return fork;
	}

	private enqueue<T>(fork: ForkRecord, operation: () => Promise<T>): Promise<T> {
		const next = fork.operation.then(operation, operation);
		fork.operation = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private snapshot(fork: ForkRecord): ForkSnapshot {
		return {
			id: fork.id,
			transcriptPath: fork.transcriptPath,
			...(fork.referencePath ? { referencePath: fork.referencePath } : {}),
			...(fork.pid ? { pid: fork.pid } : {}),
			status: fork.status,
			...(fork.activity ? { activity: fork.activity } : {}),
			turns: fork.turns,
			...(fork.lastOutput ? { lastOutput: fork.lastOutput } : {}),
			...(fork.error ? { error: fork.error } : {}),
		};
	}
}
