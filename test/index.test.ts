import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildRequest } from "../src/api.ts";

const mocks = vi.hoisted(() => {
	const fork = {
		kind: "child",
		id: "fork-1",
		task: "work",
		cwd: "/tmp/parent",
		transcriptPath: "/tmp/fork-1.jsonl",
		pid: 1234,
		status: "running",
		turns: 0,
	};
	const runSnapshot = {
		kind: "run",
		id: "run-1",
		argv: ["python", "review.py"],
		cwd: "/tmp/parent",
		childIds: [],
		stdoutPath: "/tmp/stdout.log",
		stderrPath: "/tmp/stderr.log",
		status: "running",
		delivery: "aggregate",
	};
	const start = vi.fn(async (_options: unknown) => fork);
	const run = vi.fn(async (_argv: string[], _options?: unknown) => runSnapshot);
	const status = vi.fn((_id: string) => runSnapshot);
	const stop = vi.fn(async (_id: string) => ({ ...runSnapshot, status: "stopped" }));
	const shutdown = vi.fn(async () => undefined);
	const result = vi.fn(async (_id: string, _wait?: boolean, _signal?: AbortSignal) => ({}));
	const managers: Array<{ onSettled: (job: any) => void; onOutput: (run: any, chunk: any) => void }> = [];
	let handler: (request: ChildRequest, signal: AbortSignal) => Promise<unknown>;
	const closeApi = vi.fn(async () => undefined);
	const api = vi.fn(async (callback: typeof handler) => {
		handler = callback;
		return { endpoint: "test-endpoint", token: "test-token", close: closeApi };
	});
	class FakeManager {
		constructor(options: (typeof managers)[number]) { managers.push(options); }
		list() { return []; }
		start = start;
		run = run;
		status = status;
		stop = stop;
		result = result;
		shutdown = shutdown;
	}
	return {
		FakeManager,
		fork,
		runSnapshot,
		start,
		run,
		status,
		stop,
		shutdown,
		result,
		managers,
		api,
		closeApi,
		get handler() { return handler; },
	};
});

vi.mock("../src/manager.ts", () => ({ ForkManager: mocks.FakeManager }));
vi.mock("../src/api.ts", () => ({ startApi: mocks.api }));

const cleanups: Array<() => Promise<void>> = [];

async function setup() {
	const { default: piTinyFork } = await import("../src/index.ts");
	const pi = { registerTool: vi.fn(), on: vi.fn(), sendMessage: vi.fn() };
	const ctx = {
		cwd: "/tmp/parent",
		isProjectTrusted: () => true,
		sessionManager: { getSessionDir: () => "/tmp/sessions" },
		ui: { setWidget: vi.fn() },
	};
	piTinyFork(pi as never);
	const event = (name: string) => pi.on.mock.calls.find(([type]) => type === name)?.[1];
	await event("session_start")?.({}, ctx);
	cleanups.push(async () => { await event("session_shutdown")?.({}, ctx); });
	const tools = Object.fromEntries(pi.registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
	return { pi, ctx, event, tools };
}

afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.resetModules();
	mocks.managers.length = 0;
	mocks.status.mockReturnValue(mocks.runSnapshot);
	mocks.stop.mockResolvedValue({ ...mocks.runSnapshot, status: "stopped" });
});

describe("fork extension", () => {
	it("registers parent fork and monitor tools with one manager", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		expect(Object.keys(tools)).toEqual(["Fork", "ForkSteer", "ForkStop", "monitor", "monitor_stop"]);
		expect(tools.Fork.parameters.required).toEqual(["task", "cwd", "model", "thinkingLevel"]);
		expect(tools.Fork.parameters.properties).not.toHaveProperty("context");
		expect(tools.monitor.parameters.required).toEqual(["command"]);
		expect(tools.monitor_stop.parameters.required).toEqual(["id"]);
		expect(mocks.managers[0]).toMatchObject({});
	});

	it("routes fork and API operations through the same manager", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		const forkResult = await tools.Fork.execute("call-1", { task: "work", cwd: null, model: null, thinkingLevel: null });
		expect(mocks.start).toHaveBeenCalledWith({ task: "work", cwd: undefined, model: undefined, thinkingLevel: undefined });
		expect(forkResult.content[0].text).toContain("PID: 1234");

		await mocks.handler({ op: "start", task: "script task", runId: "run-1" }, new AbortController().signal);
		expect(mocks.start).toHaveBeenLastCalledWith({ op: "start", task: "script task", runId: "run-1" });
		await mocks.handler({ op: "run", argv: ["echo", "hi"], delivery: "live" }, new AbortController().signal);
		expect(mocks.run).toHaveBeenLastCalledWith(["echo", "hi"], { op: "run", argv: ["echo", "hi"], delivery: "live" });
		await mocks.handler({ op: "status", id: "run-1" }, new AbortController().signal);
		expect(mocks.status).toHaveBeenCalledWith("run-1");
		await mocks.handler({ op: "stop", id: "run-1" }, new AbortController().signal);
		expect(mocks.stop).toHaveBeenCalledWith("run-1");
		await mocks.handler({ op: "result", id: "fork-1", wait: true }, new AbortController().signal);
		expect(mocks.result).toHaveBeenCalledWith("fork-1", true, expect.any(AbortSignal));
	});

	it("starts monitors directly with live delivery", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		const result = await tools.monitor.execute("call-1", { command: "printf hello" }, undefined, undefined, {
			cwd: "/tmp/parent",
			isProjectTrusted: () => true,
		} as never);
		expect(mocks.run).toHaveBeenCalledOnce();
		expect(mocks.run.mock.calls[0][1]).toMatchObject({ cwd: "/tmp/parent", delivery: "live" });
		expect(result.content[0].text).toContain("Monitor started");
	});

	it("only lets monitor_stop stop runs", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		mocks.status.mockReturnValue({ ...mocks.fork } as never);
		await expect(tools.monitor_stop.execute("call-1", { id: "fork-1" })).rejects.toThrow("not a monitor run");
		expect(mocks.stop).not.toHaveBeenCalled();
		mocks.status.mockReturnValue(mocks.runSnapshot);
		await tools.monitor_stop.execute("call-2", { id: "run-1" });
		expect(mocks.stop).toHaveBeenCalledWith("run-1");
	});

	it("renders launch options", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const component = tools.Fork.renderCall({ task: "work", cwd: null, model: null, thinkingLevel: null }, theme);
		expect(component.render(200).join("\n")).toContain("cwd: inherited · model: default · thinking: default");
	});

	it("keeps manager and monitor lifecycle inside children without parent hooks or API", async () => {
		vi.stubEnv("PI_FORK_CHILD", "1");
		const { pi, event, tools } = await setup();
		expect(Object.keys(tools)).toEqual(["monitor", "monitor_stop"]);
		expect(pi.on.mock.calls.map(([name]) => name)).toEqual(["session_start", "session_shutdown"]);
		expect(event("before_agent_start")).toBeUndefined();
		expect(mocks.api).not.toHaveBeenCalled();
		expect(mocks.managers).toHaveLength(1);
	});

	it("requires self-contained tasks and documents timed monitor boundaries", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { event, tools } = await setup();
		const prompt = event("before_agent_start")({ systemPrompt: "base" }).systemPrompt;
		expect(prompt).toContain("Make every fork task self-contained");
		expect(prompt).toContain("pi-child run");
		expect(tools.monitor.promptGuidelines.join(" ")).toContain("not newline boundaries");
	});

	it("sets and restores the parent CLI connection only", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		vi.stubEnv("PI_CHILD_ENDPOINT", "old-endpoint");
		vi.stubEnv("PI_CHILD_TOKEN", "old-token");
		vi.stubEnv("PI_CHILD_RUN_ID", "old-run");
		const { event, ctx } = await setup();
		expect(process.env.PI_CHILD_ENDPOINT).toBe("test-endpoint");
		expect(process.env.PI_CHILD_TOKEN).toBe("test-token");
		expect(process.env.PI_CHILD_RUN_ID).toBeUndefined();
		expect(process.env.PI_CHILD_CLI).toMatch(/pi-child\.mjs$/);
		expect(process.env.PI_CHILD_NODE).toBeTruthy();
		await event("session_shutdown")({}, ctx);
		await event("session_shutdown")({}, ctx);
		expect(mocks.shutdown).toHaveBeenCalledOnce();
		expect(mocks.closeApi).toHaveBeenCalledOnce();
		expect(process.env.PI_CHILD_ENDPOINT).toBe("old-endpoint");
		expect(process.env.PI_CHILD_TOKEN).toBe("old-token");
		expect(process.env.PI_CHILD_RUN_ID).toBe("old-run");
	});

	it("delivers live flags and final log paths without an aggregate duplicate", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { pi } = await setup();
		const options = mocks.managers[0];
		options.onOutput({ ...mocks.runSnapshot, delivery: "live" }, {
			text: "partial",
			startsWithContinuation: true,
			endsWithPartialLine: true,
		});
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const liveText = pi.sendMessage.mock.calls[0][0].content;
		expect(liveText).toContain("[run-1 · continues previous line · last line incomplete]");
		expect(liveText).toContain("]\npartial");

		options.onOutput({ ...mocks.runSnapshot, delivery: "live", status: "completed", exitCode: 0 }, {
			text: "",
			startsWithContinuation: false,
			endsWithPartialLine: false,
			streamEnded: true,
		});
		const finalText = pi.sendMessage.mock.calls[1][0].content;
		expect(finalText).toContain("[run-1 · status: completed · exit code: 0 · stdout: /tmp/stdout.log · stderr: /tmp/stderr.log]");
		expect(finalText.endsWith("]\n")).toBe(true);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("includes suppression reason and keeps aggregate notifications bounded", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { pi } = await setup();
		const options = mocks.managers[0];
		options.onOutput({ ...mocks.runSnapshot, delivery: "live" }, {
			text: "output limit exceeded",
			startsWithContinuation: false,
			endsWithPartialLine: false,
			suppressed: true,
		});
		const suppressed = pi.sendMessage.mock.calls[0][0].content;
		expect(suppressed.split("output limit exceeded")).toHaveLength(2);
		expect(suppressed).toContain("suppressed:");
		expect(suppressed).toContain("stdout log: /tmp/stdout.log");

		options.onSettled({
			...mocks.runSnapshot,
			delivery: "aggregate",
			status: "completed",
			lastOutput: "done".repeat(30_000),
		});
		const aggregate = pi.sendMessage.mock.calls[1][0].content;
		expect(aggregate).toContain("Run completed");
		expect(aggregate).toContain("Stdout: /tmp/stdout.log");
		expect(Buffer.byteLength(aggregate)).toBeLessThan(51 * 1024);
	});
});
