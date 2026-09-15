import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForkManager, type JobSnapshot } from "../src/manager.ts";

const mocks = vi.hoisted(() => {
	type Listener = (value: any) => void;
	const start = vi.fn(async (): Promise<void> => undefined);
	const prompt = vi.fn(async (_message: string): Promise<void> => undefined);
	const steer = vi.fn(async (_message: string): Promise<void> => undefined);
	const stop = vi.fn(async (): Promise<void> => undefined);
	const defaults = vi.fn((): { model?: string; thinkingLevel?: "high" } => ({}));
	const createSession = vi.fn(() => "/tmp/child.jsonl");
	class FakeRpcChild {
		alive = true;
		events: Listener[] = [];
		exits: Listener[] = [];
		abort = vi.fn(async () => undefined);
		constructor(readonly cwd: string, readonly sessionFile: string, readonly options: unknown) { children.push(this); }
		isAlive() { return this.alive; }
		getPid() { return 1234; }
		getStderr() { return ""; }
		onEvent(listener: Listener) { this.events.push(listener); }
		onExit(listener: Listener) { this.exits.push(listener); }
		start = start;
		prompt = prompt;
		steer = steer;
		async stop() { this.alive = false; await stop(); }
		emit(event: unknown) { for (const listener of this.events) listener(event); }
		exit() { this.alive = false; for (const listener of this.exits) listener({ code: 1, signal: null }); }
	}
	const children: FakeRpcChild[] = [];
	return { FakeRpcChild, children, start, prompt, steer, stop, defaults, createSession };
});

vi.mock("../src/rpc.ts", () => ({ RpcChild: mocks.FakeRpcChild }));
vi.mock("../src/fork.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/fork.ts")>(), createForkSession: mocks.createSession,
}));
vi.mock("../src/fork-settings.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/fork-settings.ts")>(), loadForkDefaults: mocks.defaults,
}));

const cwd = join(tmpdir(), "parent");
const parentSession = join(tmpdir(), "parent.jsonl");
const request = { task: "work", model: "provider/test", thinkingLevel: "medium" as const };

function createManager(settled: JobSnapshot[] = []) {
	return new ForkManager({ cwd, sessionDir: join(tmpdir(), "sessions"), parentSession, onUpdate: () => undefined, onSettled: (job) => settled.push(job) });
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.children.length = 0;
	mocks.defaults.mockReturnValue({});
	mocks.createSession.mockReturnValue(join(tmpdir(), "child.jsonl"));
});

describe("fork manager", () => {
	it("requires a model and thinking level before launching", async () => {
		const manager = createManager();
		await expect(manager.start({ task: "work" })).rejects.toThrow("Fork requires a model");
		await expect(manager.start({ task: "work", model: "provider/test" })).rejects.toThrow("Fork requires a thinking level");
		expect(mocks.children).toEqual([]);
	});

	it("resolves defaults centrally and lets explicit options override them independently", async () => {
		mocks.defaults.mockReturnValue({ model: "provider/default", thinkingLevel: "high" });
		const manager = createManager();
		await manager.start({ task: "work", model: "provider/explicit" });
		expect(mocks.children[0].options).toEqual({ model: "provider/explicit", thinkingLevel: "high" });
	});

	it("links fresh sessions to the parent with either inherited or explicit relative cwd", async () => {
		const manager = createManager();
		await manager.start(request);
		await manager.start({ ...request, cwd: "child" });
		expect(mocks.createSession.mock.calls).toEqual([
			[cwd, join(tmpdir(), "sessions"), "work", parentSession],
			[join(cwd, "child"), join(tmpdir(), "sessions"), "work", parentSession],
		]);
	});

	it("tracks progress and final output, then settles and cleans up once", async () => {
		const settled: JobSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(request);
		const child = mocks.children[0];
		expect(started).toMatchObject({ status: "running", pid: 1234 });
		expect(mocks.prompt.mock.calls[0][0]).toContain("\nwork\n");
		child.emit({ type: "turn_start" });
		child.emit({ type: "tool_execution_start", toolName: "read" });
		expect(manager.list()[0]).toMatchObject({ activity: "read" });
		child.emit({ type: "tool_execution_end", toolName: "read" });
		child.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
		child.emit({ type: "agent_settled" });
		child.emit({ type: "agent_settled" });
		await manager.result(started.id, true);
		expect(manager.list()[0]).toMatchObject({ status: "completed", turns: 1, lastOutput: "done" });
		expect(mocks.stop).toHaveBeenCalledOnce();
		expect(settled).toHaveLength(1);
	});

	it.each(["error", "aborted"])("reports a final %s response as failed", async (stopReason) => {
		const manager = createManager();
		const child = await manager.start(request);
		mocks.children[0].emit({ type: "message_end", message: { role: "assistant", content: [], stopReason, errorMessage: "model failed" } });
		mocks.children[0].emit({ type: "agent_settled" });
		expect(await manager.result(child.id, true)).toMatchObject({ status: "failed", error: "model failed" });
	});

	it("does not reuse stale output after an empty final response", async () => {
		const manager = createManager();
		await manager.start(request);
		mocks.children[0].emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old" }], stopReason: "stop" } });
		mocks.children[0].emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
		expect(manager.list()[0]).not.toHaveProperty("lastOutput");
	});

	it("reports unexpected exit and ignores late events", async () => {
		const settled: JobSnapshot[] = [];
		const manager = createManager(settled);
		await manager.start(request);
		mocks.children[0].exit();
		mocks.children[0].emit({ type: "turn_start" });
		await manager.result(manager.list()[0].id, true);
		expect(manager.list()[0]).toMatchObject({ status: "failed", turns: 0, error: "Process exited with 1" });
		expect(settled).toHaveLength(1);
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("reports launch failure exactly once", async () => {
		const settled: JobSnapshot[] = [];
		mocks.start.mockRejectedValue(new Error("startup failed"));
		const manager = createManager(settled);
		await expect(manager.start(request)).rejects.toThrow("Could not start");
		mocks.children[0].emit({ type: "agent_settled" });
		expect(settled).toHaveLength(1);
		expect(settled[0]).toMatchObject({ status: "failed", error: "startup failed" });
	});

	it("preserves the settled failure if the prompt fails after process exit and awaits cleanup", async () => {
		const gate = deferred();
		mocks.stop.mockReturnValue(gate.promise);
		mocks.prompt.mockImplementation(async () => { mocks.children[0].exit(); throw new Error("prompt failed"); });
		const settled: JobSnapshot[] = [];
		const manager = createManager(settled);
		let rejected = false;
		const starting = manager.start(request);
		void starting.catch(() => { rejected = true; });
		await new Promise((resolve) => setImmediate(resolve));
		expect(mocks.stop).toHaveBeenCalledOnce();
		expect(rejected).toBe(false);
		gate.resolve();
		await expect(starting).rejects.toThrow("prompt failed");
		expect(settled).toHaveLength(1);
		expect(settled[0].error).toBe("Process exited with 1");
	});

	it("keeps completed children terminal", async () => {
		const manager = createManager();
		const started = await manager.start(request);
		mocks.children[0].emit({ type: "agent_settled" });
		mocks.children[0].emit({ type: "turn_start" });
		await expect(manager.stop(started.id)).rejects.toThrow("not running");
		await expect(manager.steer(started.id, "more")).rejects.toThrow("not running");
		expect(manager.list()[0]).toMatchObject({ status: "completed", turns: 0 });
	});

	it("stops without waiting for an unresponsive abort", async () => {
		const settled: JobSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(request);
		mocks.children[0].abort.mockReturnValue(new Promise(() => undefined));
		expect((await manager.stop(started.id)).status).toBe("stopped");
		expect(settled).toHaveLength(1);
		expect(mocks.stop).toHaveBeenCalledOnce();
	});

	it("does not let pending steering block shutdown", async () => {
		const gate = deferred();
		mocks.steer.mockReturnValue(gate.promise);
		const settled: JobSnapshot[] = [];
		const manager = createManager(settled);
		const started = await manager.start(request);
		const steering = manager.steer(started.id, "more");
		await manager.shutdown();
		expect(mocks.children[0].isAlive()).toBe(false);
		expect(settled).toEqual([]);
		gate.resolve();
		await steering;
	});

	it("waits without blocking steering and can cancel only the waiter", async () => {
		const manager = createManager();
		const child = await manager.start(request);
		await expect(manager.result(child.id)).rejects.toThrow("has not finished");
		const controller = new AbortController();
		const waiting = manager.result(child.id, true, controller.signal);
		const rejected = expect(waiting).rejects.toThrow("wait cancelled");
		await manager.steer(child.id, "new direction");
		controller.abort(new Error("wait cancelled"));
		await rejected;
		expect(manager.status(child.id).status).toBe("running");
		const finished = manager.result(child.id, true);
		mocks.children[0].emit({ type: "agent_settled" });
		expect(await finished).toMatchObject({ status: "completed" });
		expect(await manager.result(child.id)).toMatchObject({ status: "completed" });
	});

	it("keeps a startup cancellation terminal and never sends its task", async () => {
		const gate = deferred();
		mocks.start.mockReturnValue(gate.promise);
		const settled: JobSnapshot[] = [];
		const manager = createManager(settled);
		const starting = manager.start(request);
		const failed = expect(starting).rejects.toThrow("stopped during startup");
		const id = manager.list()[0].id;
		await manager.stop(id);
		gate.resolve();
		await failed;
		expect(manager.status(id).status).toBe("stopped");
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(settled).toHaveLength(1);
	});

	it("does not publish a terminal status until cleanup finishes", async () => {
		const gate = deferred();
		mocks.stop.mockReturnValue(gate.promise);
		const manager = createManager();
		const child = await manager.start(request);
		mocks.children[0].emit({ type: "agent_settled" });
		expect(manager.status(child.id).status).toBe("running");
		await expect(manager.result(child.id)).rejects.toThrow("has not finished");
		await expect(manager.stop(child.id)).rejects.toThrow("not running");
		gate.resolve();
		expect(await manager.result(child.id, true)).toMatchObject({ status: "completed" });
	});

	it("reports cleanup failure to waiters instead of leaving them pending", async () => {
		const manager = createManager();
		const child = await manager.start(request);
		mocks.stop.mockRejectedValue(new Error("cannot stop"));
		const result = manager.result(child.id, true);
		mocks.children[0].emit({ type: "agent_settled" });
		expect(await result).toMatchObject({ status: "failed", error: "Child cleanup failed: cannot stop" });
	});

	it("does not send a prompt when shutdown races startup", async () => {
		const gate = deferred();
		mocks.start.mockReturnValue(gate.promise);
		const manager = createManager();
		const starting = manager.start(request);
		const failed = expect(starting).rejects.toThrow("Could not start");
		const shutdown = manager.shutdown();
		gate.resolve();
		await failed;
		await shutdown;
		expect(manager.list()[0].status).toBe("stopped");
		expect(mocks.prompt).not.toHaveBeenCalled();
	});
});
