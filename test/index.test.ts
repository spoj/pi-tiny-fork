import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForkStartOptions, JobSnapshot } from "../src/manager.ts";
import type { ChildRequest } from "../src/api.ts";

const mocks = vi.hoisted(() => {
	const start = vi.fn(async (_options: ForkStartOptions) => ({
		kind: "child", id: "fork-1", task: "work", cwd: "/tmp/parent", transcriptPath: "/tmp/fork-1.jsonl", pid: 1234, status: "running", turns: 0,
	}));
	const shutdown = vi.fn(async () => undefined);
	const closeApi = vi.fn(async () => undefined);
	const result = vi.fn(async (_id: string, _wait?: boolean, _signal?: AbortSignal) => ({}));
	const managers: Array<{ cwd: string; sessionDir: string; onSettled: (job: JobSnapshot) => void }> = [];
	let handler: (request: ChildRequest, signal: AbortSignal) => Promise<unknown>;
	const api = vi.fn(async (callback: typeof handler) => {
		handler = callback;
		return { endpoint: "test-endpoint", token: "test-token", close: closeApi };
	});
	class FakeManager {
		constructor(options: typeof managers[number]) { managers.push(options); }
		list() { return []; }
		start = start;
		result = result;
		shutdown = shutdown;
	}
	return { FakeManager, start, shutdown, closeApi, result, managers, api, get handler() { return handler; } };
});

vi.mock("../src/manager.ts", () => ({ ForkManager: mocks.FakeManager }));
vi.mock("../src/api.ts", () => ({ startApi: mocks.api }));

const cleanups: Array<() => Promise<void>> = [];

async function setup() {
	const { default: piTinyFork } = await import("../src/index.ts");
	const pi = { registerTool: vi.fn(), on: vi.fn(), sendMessage: vi.fn() };
	const ctx = { cwd: "/tmp/parent", sessionManager: { getSessionDir: () => "/tmp/sessions" }, ui: { setWidget: vi.fn() } };
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
});

describe("fork extension", () => {
	it("registers only the three fresh-context tools at session start", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		expect(Object.keys(tools)).toEqual(["Fork", "ForkSteer", "ForkStop"]);
		expect(tools.Fork.parameters.required).toEqual(["task", "cwd", "model", "thinkingLevel"]);
		expect(tools.Fork.parameters.properties).not.toHaveProperty("context");
		expect(mocks.managers[0]).toMatchObject({ cwd: "/tmp/parent", sessionDir: "/tmp/sessions" });
	});

	it("routes tools and API requests through the same manager", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		const result = await tools.Fork.execute("call-1", { task: "work", cwd: null, model: null, thinkingLevel: null });
		expect(mocks.start).toHaveBeenCalledWith({ task: "work", cwd: undefined, model: undefined, thinkingLevel: undefined });
		expect(result.content[0].text).toContain("PID: 1234");
		const signal = new AbortController().signal;
		await mocks.handler({ op: "start", task: "script task", runId: "run-1" }, signal);
		expect(mocks.start).toHaveBeenLastCalledWith({ op: "start", task: "script task", runId: "run-1" });
		await mocks.handler({ op: "result", id: "fork-1", wait: true }, signal);
		expect(mocks.result).toHaveBeenCalledWith("fork-1", true, signal);
	});

	it("renders the launch options", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const component = tools.Fork.renderCall({ task: "work", cwd: null, model: null, thinkingLevel: null }, theme);
		expect(component.render(200).join("\n")).toContain("cwd: inherited · model: default · thinking: default");
	});

	it("does not register tools, hooks, or an API inside children", async () => {
		vi.stubEnv("PI_FORK_CHILD", "1");
		const { pi } = await setup();
		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(pi.on).not.toHaveBeenCalled();
		expect(mocks.api).not.toHaveBeenCalled();
		expect(mocks.managers).toEqual([]);
	});

	it("requires self-contained tasks and background script waits in parent guidance", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { event } = await setup();
		const prompt = event("before_agent_start")({ systemPrompt: "base" }).systemPrompt;
		expect(prompt).toContain("Make the task self-contained");
		expect(prompt).toContain("pi-child run");
		expect(prompt).toContain("Do not wait for children or runs in the parent conversation");
	});

	it("exposes the session connection to scripts and restores it on idempotent shutdown", async () => {
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

	it("notifies the parent with bounded output and saved output paths", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { pi } = await setup();
		mocks.managers[0].onSettled({
			kind: "run", id: "run-1", argv: ["python", "review.py"], cwd: "/tmp", childIds: ["fork-1"],
			stdoutPath: "/tmp/stdout.log", stderrPath: "/tmp/stderr.log", status: "completed", lastOutput: "done".repeat(30_000),
		});
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const text = pi.sendMessage.mock.calls[0][0].content;
		expect(text).toContain("Run completed");
		expect(text).toContain("Stdout: /tmp/stdout.log");
		expect(text).toContain("Output truncated");
		expect(Buffer.byteLength(text)).toBeLessThan(51 * 1024);
	});
});
