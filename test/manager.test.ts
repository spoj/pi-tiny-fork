import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ForkManager, type ForkSnapshot } from "../src/manager.ts";

const mocks = vi.hoisted(() => {
	type Listener = (value: unknown) => void;

	class FakeRpcChild {
		private alive = true;
		private readonly eventListeners = new Set<Listener>();
		private readonly exitListeners = new Set<Listener>();
		readonly prompts: string[] = [];
		abortCalls = 0;
		stopCalls = 0;

		constructor(
			readonly cwd: string,
			readonly sessionFile: string,
			readonly options: unknown,
		) {
			children.push(this);
		}

		isAlive(): boolean {
			return this.alive;
		}

		getPid(): number {
			return 1234;
		}

		getStderr(): string {
			return "";
		}

		onEvent(listener: Listener): () => void {
			this.eventListeners.add(listener);
			return () => this.eventListeners.delete(listener);
		}

		onExit(listener: Listener): () => void {
			this.exitListeners.add(listener);
			return () => this.exitListeners.delete(listener);
		}

		async start(): Promise<void> {
			if (startGate) await startGate;
			if (startError) throw startError;
		}

		async prompt(message: string): Promise<void> {
			this.prompts.push(message);
			if (promptError) {
				if (exitBeforePromptError) this.exit({ code: 0, signal: null });
				throw promptError;
			}
		}

		async steer(message: string): Promise<void> {
			this.prompts.push(message);
			if (steerGate) await steerGate;
		}

		abortHangs = false;

		async abort(): Promise<void> {
			this.abortCalls++;
			if (this.abortHangs) await new Promise(() => undefined);
		}

		async stop(): Promise<void> {
			this.stopCalls++;
			this.alive = false;
			if (stopGate) await stopGate;
		}

		emit(event: unknown): void {
			for (const listener of this.eventListeners) listener(event);
		}

		exit(exit: unknown): void {
			this.alive = false;
			for (const listener of this.exitListeners) listener(exit);
		}
	}

	const children: FakeRpcChild[] = [];
	const sessionCalls: Array<{ context: string; toolCallId: string; cwd: string; name?: string }> = [];
	let startGate: Promise<void> | undefined;
	let steerGate: Promise<void> | undefined;
	let startError: Error | undefined;
	let promptError: Error | undefined;
	let exitBeforePromptError = false;
	let stopGate: Promise<void> | undefined;
	return {
		children,
		sessionCalls,
		FakeRpcChild,
		get startGate() {
			return startGate;
		},
		set startGate(value: Promise<void> | undefined) {
			startGate = value;
		},
		get steerGate() {
			return steerGate;
		},
		set steerGate(value: Promise<void> | undefined) {
			steerGate = value;
		},
		get startError() {
			return startError;
		},
		set startError(value: Error | undefined) {
			startError = value;
		},
		get promptError() {
			return promptError;
		},
		set promptError(value: Error | undefined) {
			promptError = value;
		},
		get exitBeforePromptError() {
			return exitBeforePromptError;
		},
		set exitBeforePromptError(value: boolean) {
			exitBeforePromptError = value;
		},
		get stopGate() {
			return stopGate;
		},
		set stopGate(value: Promise<void> | undefined) {
			stopGate = value;
		},
	};
});

vi.mock("../src/rpc.ts", () => ({ RpcChild: mocks.FakeRpcChild }));
vi.mock("../src/fork.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/fork.ts")>(),
	createForkSession: (_sessionManager: unknown, context: string, toolCallId: string, cwd: string, name?: string) => {
		mocks.sessionCalls.push({ context, toolCallId, cwd, name });
		return {
			transcriptPath: "/tmp/child.jsonl",
			referencePath: context === "reference" ? "/tmp/references/parent.jsonl" : undefined,
		};
	},
}));

const context = { cwd: "/tmp/parent", sessionManager: {} } as unknown as ExtensionContext;
const launchOptions = { model: "provider/test", thinkingLevel: "medium" as const };

function createManager(settled: ForkSnapshot[] = []): ForkManager {
	return new ForkManager({
		onUpdate: () => undefined,
		onSettled: (fork) => settled.push(fork),
	});
}

beforeEach(() => {
	mocks.children.length = 0;
	mocks.sessionCalls.length = 0;
	mocks.startGate = undefined;
	mocks.steerGate = undefined;
	mocks.startError = undefined;
	mocks.promptError = undefined;
	mocks.exitBeforePromptError = false;
	mocks.stopGate = undefined;
});

describe("fork manager", () => {
	it("refuses to start without a model or thinking level", async () => {
		const manager = createManager();

		await expect(manager.start(context, "work", "full", {}, "call-1")).rejects.toThrow(
			"First check which models are available, then ask the user to choose one; do not assume a model",
		);
		await expect(manager.start(context, "work", "full", { model: "provider/test" }, "call-1")).rejects.toThrow(
			"Fork requires a thinking level: ask the user to choose one",
		);
		expect(mocks.children).toHaveLength(0);
	});

	it("materializes forks with the effective parent cwd or the resolved explicit cwd", async () => {
		const manager = createManager();

		await manager.start(context, "work", "full", launchOptions, "call-1");
		await manager.start(context, "work", "full", launchOptions, "call-1", "child");

		expect(mocks.sessionCalls.map(({ toolCallId, cwd }) => ({ toolCallId, cwd }))).toEqual([
			{ toolCallId: "call-1", cwd: "/tmp/parent" },
			{ toolCallId: "call-1", cwd: "/tmp/parent/child" },
		]);
	});

	it.each(["full", "reference", "none"] as const)("tracks %s context, turns, final output, and completion", async (mode) => {
		const settled: ForkSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(context, "work", mode, launchOptions, "call-1");
		const child = mocks.children[0];
		expect(child.prompts[0]).toContain("work");
		expect(child.prompts[0].includes("Parent conversation snapshot:")).toBe(mode === "reference");
		if (mode === "reference") expect(child.prompts[0]).toContain(started.referencePath);

		child.emit({ type: "turn_start" });
		child.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		});
		child.emit({ type: "agent_settled" });

		expect(started).toMatchObject({ status: "running", pid: 1234 });
		expect(manager.list()[0]).toMatchObject({ status: "completed", turns: 1, lastOutput: "done" });
		expect(child.stopCalls).toBe(1);
		expect(settled).toHaveLength(1);
	});

	it("does not report stale output after an empty assistant message", async () => {
		const manager = createManager();
		await manager.start(context, "work", "full", launchOptions, "call-1");
		const child = mocks.children[0];

		child.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "old output" }],
				stopReason: "stop",
			},
		});
		child.emit({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "stop" },
		});

		expect(manager.list()[0]).not.toHaveProperty("lastOutput");
	});

	it("waits for queued operations during shutdown without settling them", async () => {
		const settled: ForkSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(context, "work", "full", launchOptions, "call-1");
		let releaseSteer!: () => void;
		mocks.steerGate = new Promise<void>((resolve) => {
			releaseSteer = resolve;
		});
		const steering = manager.steer(started.id, "steer");
		await Promise.resolve();
		const stopping = manager.stop(started.id);

		let shutdownFinished = false;
		const shuttingDown = manager.shutdown().then(() => {
			shutdownFinished = true;
		});
		await Promise.resolve();
		expect(shutdownFinished).toBe(false);

		releaseSteer();
		await steering;
		await stopping;
		await shuttingDown;
		expect(settled).toHaveLength(0);
	});

	it("reports an unexpected child exit as a failure", async () => {
		const settled: ForkSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(context, "work", "full", launchOptions, "call-1");

		mocks.children[0].exit({ code: 1, signal: null });

		expect(manager.list()[0]).toMatchObject({
			id: started.id,
			status: "failed",
			error: "Process exited with 1",
		});
		expect(mocks.children[0].stopCalls).toBe(1);
		expect(settled).toHaveLength(1);
	});

	it("waits for cleanup when prompt failure follows leader exit", async () => {
		let releaseCleanup!: () => void;
		mocks.stopGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		mocks.promptError = new Error("prompt failed");
		mocks.exitBeforePromptError = true;
		const manager = createManager();
		const starting = manager.start(context, "work", "full", launchOptions, "call-1");

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mocks.children[0].stopCalls).toBe(1);
		let rejected = false;
		void starting.catch(() => {
			rejected = true;
		});
		await Promise.resolve();
		expect(rejected).toBe(false);

		releaseCleanup();
		await expect(starting).rejects.toThrow("prompt failed");
	});

	it("reports a startup failure exactly once", async () => {
		const settled: ForkSnapshot[] = [];
		mocks.startError = new Error("startup failed");
		const manager = createManager(settled);

		await expect(manager.start(context, "work", "full", launchOptions, "call-1")).rejects.toThrow("Could not start");

		expect(settled).toHaveLength(1);
		expect(settled[0]).toMatchObject({ status: "failed", error: "startup failed" });
		mocks.children[0].emit({ type: "agent_settled" });
		expect(settled).toHaveLength(1);
		expect(manager.list()[0].status).toBe("failed");
	});

	it("stops an active child and settles it once", async () => {
		const settled: ForkSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(context, "work", "full", launchOptions, "call-1");
		const child = mocks.children[0];

		const stopped = await manager.stop(started.id);

		expect(stopped.status).toBe("stopped");
		expect(child.abortCalls).toBe(1);
		expect(child.stopCalls).toBe(1);
		expect(settled).toHaveLength(1);
	});

	it("stops without waiting for an unresponsive abort request", async () => {
		const manager = createManager();
		const started = await manager.start(context, "work", "full", launchOptions, "call-1");
		const child = mocks.children[0];
		child.abortHangs = true;

		const stopped = await manager.stop(started.id);

		expect(stopped.status).toBe("stopped");
		expect(child.abortCalls).toBe(1);
		expect(child.stopCalls).toBe(1);
	});

	it("does not let shutdown race an in-flight start", async () => {
		let releaseStart!: () => void;
		mocks.startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const manager = createManager();
		const starting = manager.start(context, "work", "full", launchOptions, "call-1");
		await Promise.resolve();
		const child = mocks.children[0];

		const shuttingDown = manager.shutdown();
		const startingFailure = expect(starting).rejects.toThrow("Could not start");
		releaseStart();

		await startingFailure;
		await shuttingDown;
		expect(child.prompts).toEqual([]);
		expect(manager.list()[0].status).toBe("failed");
	});

	it("does not change a completed child to stopped", async () => {
		const manager = createManager();
		const started = await manager.start(context, "work", "full", launchOptions, "call-1");
		mocks.children[0].emit({ type: "agent_settled" });

		await expect(manager.stop(started.id)).rejects.toThrow(`${started.id} is not running`);
		expect(manager.list()[0].status).toBe("completed");
	});
});
