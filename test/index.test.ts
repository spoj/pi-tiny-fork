import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForkSnapshot, ForkStartOptions } from "../src/manager.ts";

const mocks = vi.hoisted(() => {
	const start = vi.fn(async (_options: ForkStartOptions) => ({
		id: "fork-1", transcriptPath: "/tmp/fork-1.jsonl", pid: 1234, status: "running", turns: 0,
	}));
	const shutdown = vi.fn(async () => undefined);
	const managers: Array<{ cwd: string; sessionDir: string; onSettled: (fork: ForkSnapshot) => void }> = [];
	class FakeManager {
		constructor(options: typeof managers[number]) { managers.push(options); }
		list() { return []; }
		start = start;
		shutdown = shutdown;
	}
	return { FakeManager, start, shutdown, managers };
});

vi.mock("../src/manager.ts", () => ({ ForkManager: mocks.FakeManager }));

async function setup() {
	const { default: piTinyFork } = await import("../src/index.ts");
	const pi = { registerTool: vi.fn(), on: vi.fn(), sendMessage: vi.fn() };
	const ctx = { cwd: "/tmp/parent", sessionManager: { getSessionDir: () => "/tmp/sessions" }, ui: { setWidget: vi.fn() } };
	piTinyFork(pi as never);
	const event = (name: string) => pi.on.mock.calls.find(([type]) => type === name)?.[1];
	await event("session_start")?.({}, ctx);
	const tools = Object.fromEntries(pi.registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
	return { pi, ctx, event, tools };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.resetModules();
	mocks.managers.length = 0;
});

describe("fork tools", () => {
	it("registers only the three fresh-context tools at session start", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		expect(Object.keys(tools)).toEqual(["Fork", "ForkSteer", "ForkStop"]);
		expect(tools.Fork.parameters.required).toEqual(["task", "cwd", "model", "thinkingLevel"]);
		expect(tools.Fork.parameters.properties).not.toHaveProperty("context");
		expect(mocks.managers[0]).toMatchObject({ cwd: "/tmp/parent", sessionDir: "/tmp/sessions" });
	});

	it("passes nullable options to the shared manager without resolving defaults in the tool", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		const result = await tools.Fork.execute("call-1", { task: "work", cwd: null, model: null, thinkingLevel: null });
		expect(mocks.start).toHaveBeenCalledWith({ task: "work", cwd: undefined, model: undefined, thinkingLevel: undefined });
		expect(result.content[0].text).toContain("PID: 1234");
	});

	it("renders the launch options", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { tools } = await setup();
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const component = tools.Fork.renderCall({ task: "work", cwd: null, model: null, thinkingLevel: null }, theme);
		expect(component.render(200).join("\n")).toContain("cwd: inherited · model: default · thinking: default");
	});

	it("does not register orchestration tools or hooks inside children", async () => {
		vi.stubEnv("PI_FORK_CHILD", "1");
		const { pi } = await setup();
		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(pi.on).not.toHaveBeenCalled();
		expect(mocks.managers).toEqual([]);
	});

	it("requires self-contained tasks in parent guidance", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { event } = await setup();
		expect(event("before_agent_start")({ systemPrompt: "base" }).systemPrompt).toContain("Make the task self-contained");
	});

	it("notifies the parent on completion and cleans up on session shutdown", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { pi, event, ctx } = await setup();
		mocks.managers[0].onSettled({ id: "fork-1", transcriptPath: "/tmp/fork-1.jsonl", status: "completed", turns: 1, lastOutput: "done" });
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls[0][0].content).toContain("done");
		await event("session_shutdown")({}, ctx);
		expect(mocks.shutdown).toHaveBeenCalledOnce();
	});
});
