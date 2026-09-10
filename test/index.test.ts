import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForkSnapshot } from "../src/manager.ts";

const mocks = vi.hoisted(() => {
	let managerOptions: { onSettled: (fork: ForkSnapshot) => void } | undefined;
	let forkDefaults: { model?: string; thinkingLevel?: string } = {};
	const startCalls: Array<{
		ctx: unknown;
		prompt: string;
		context: string;
		launchOptions: { model?: string; thinkingLevel?: string };
		toolCallId: string;
		cwd?: string;
	}> = [];

	class FakeManager {
		constructor(options: typeof managerOptions) {
			managerOptions = options;
		}

		list() {
			return [{ status: "running" }];
		}

		async start(
			ctx: unknown,
			prompt: string,
			context: string,
			launchOptions: { model?: string; thinkingLevel?: string },
			toolCallId: string,
			cwd?: string,
		) {
			startCalls.push({ ctx, prompt, context, launchOptions, toolCallId, cwd });
			return {
				id: "fork-1",
				transcriptPath: "/tmp/fork-1.jsonl",
				pid: 1234,
				status: "starting",
				turns: 0,
			};
		}
	}

	return {
		FakeManager,
		startCalls,
		get forkDefaults() {
			return forkDefaults;
		},
		set forkDefaults(value: { model?: string; thinkingLevel?: string }) {
			forkDefaults = value;
		},
		get managerOptions() {
			return managerOptions;
		},
	};
});

vi.mock("../src/manager.ts", () => ({ ForkManager: mocks.FakeManager }));
vi.mock("../src/fork-settings.ts", async () => {
	const actual = await vi.importActual<typeof import("../src/fork-settings.ts")>("../src/fork-settings.ts");
	return { ...actual, loadForkDefaults: () => mocks.forkDefaults };
});

const originalChildFlag = process.env.PI_FORK_CHILD;

afterEach(() => {
	if (originalChildFlag === undefined) delete process.env.PI_FORK_CHILD;
	else process.env.PI_FORK_CHILD = originalChildFlag;
	mocks.startCalls.length = 0;
	mocks.forkDefaults = {};
	vi.resetModules();
});

describe("fork tools", () => {
	it("requires an explicit context mode alongside nullable launch options", async () => {
		delete process.env.PI_FORK_CHILD;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piTinyFork(pi as never);
		const toolNames = pi.registerTool.mock.calls.map(([tool]) => tool.name);
		const forkTool = pi.registerTool.mock.calls.find(([tool]) => tool.name === "Fork")?.[0];
		const properties = forkTool.parameters.properties;

		expect(toolNames).toEqual(["Fork", "ForkSteer", "ForkStop"]);

		expect(properties).toHaveProperty("task");
		expect(properties).not.toHaveProperty("advanced_options");
		expect(properties).not.toHaveProperty("prompt");
		expect(properties).toEqual(
			expect.objectContaining({ model: expect.any(Object), thinkingLevel: expect.any(Object), cwd: expect.any(Object) }),
		);
		expect(forkTool.parameters.required).toEqual(["task", "context", "cwd", "model", "thinkingLevel"]);
		expect(properties.context).toMatchObject({ type: "string", enum: ["full", "reference", "none"] });
		expect(properties.cwd.anyOf).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "string" }), { type: "null" }]),
		);
		expect(properties.model.anyOf).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "string" }), { type: "null" }]),
		);
		expect(properties.thinkingLevel.anyOf).toEqual(expect.arrayContaining([{ type: "null" }]));
	});

	it("renders fork tool arguments", async () => {
		delete process.env.PI_FORK_CHILD;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};

		piTinyFork(pi as never);
		const tools = Object.fromEntries(pi.registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
		const fork = tools.Fork.renderCall(
			{ task: "inspect rendering", context: "reference", cwd: null, model: null, thinkingLevel: null },
			theme as never,
			{} as never,
		);
		const steer = tools.ForkSteer.renderCall(
			{ id: "fork-1234", prompt: "check the tests" },
			theme as never,
			{} as never,
		);
		const stop = tools.ForkStop.renderCall({ id: "fork-1234" }, theme as never, {} as never);
		const rendered = (component: { render: (width: number) => string[] }) =>
			component.render(200).map((line) => line.trimEnd()).join("\n");

		expect(rendered(fork)).toContain("Fork inspect rendering\ncontext: reference · cwd: inherited · model: default · thinking: default");
		expect(rendered(steer)).toContain("Fork Steer fork-1234\ncheck the tests");
		expect(rendered(stop)).toContain("Fork Stop fork-1234");
	});

	it.each(["full", "reference", "none"])("passes %s context and resolves null launch options", async (context) => {
		delete process.env.PI_FORK_CHILD;
		mocks.forkDefaults = { model: "provider/default", thinkingLevel: "high" };
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piTinyFork(pi as never);
		const forkTool = pi.registerTool.mock.calls.find(([tool]) => tool.name === "Fork")?.[0];
		const result = await forkTool.execute(
			"call-1",
			{ task: "check defaults", context, cwd: null, model: null, thinkingLevel: null },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.content[0].text).toContain("PID: 1234");
		expect(mocks.startCalls).toHaveLength(1);
		expect(mocks.startCalls[0]).toMatchObject({ prompt: "check defaults", context, toolCallId: "call-1", cwd: undefined });
		expect(mocks.startCalls[0].launchOptions).toEqual({ model: "provider/default", thinkingLevel: "high" });
	});

	it.each([
		{ defaults: {}, message: "First check which models are available, then ask the user to choose one; do not assume a model" },
		{ defaults: { model: "provider/default" }, message: "Fork requires a thinking level: ask the user to choose one" },
	])("refuses to start without a complete fork configuration", async ({ defaults, message }) => {
		delete process.env.PI_FORK_CHILD;
		mocks.forkDefaults = defaults;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piTinyFork(pi as never);
		const forkTool = pi.registerTool.mock.calls.find(([tool]) => tool.name === "Fork")?.[0];
		await expect(
			forkTool.execute(
				"call-1",
				{ task: "check configuration", context: "full", cwd: null, model: null, thinkingLevel: null },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(message);
		expect(mocks.startCalls).toHaveLength(0);
	});

	it("shares system guidance and tool schemas between parent and children", async () => {
		const surfaces = [];
		for (const child of [false, true]) {
			if (child) process.env.PI_FORK_CHILD = "1";
			else delete process.env.PI_FORK_CHILD;
			vi.resetModules();
			const { default: piTinyFork } = await import("../src/index.ts");
			const pi = { registerTool: vi.fn(), on: vi.fn(), sendMessage: vi.fn() };
			piTinyFork(pi as never);
			const tools = pi.registerTool.mock.calls.map(([tool]) => tool);
			const beforeStart = pi.on.mock.calls.find(([event]) => event === "before_agent_start")![1];
			surfaces.push({
				tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
				prompt: beforeStart({ systemPrompt: "base" }),
			});
			if (child) {
				for (const tool of tools) {
					await expect(tool.execute("call", {})).rejects.toThrow("unavailable inside a delegated fork");
				}
			}
		}
		expect(surfaces[0]).toEqual(surfaces[1]);
	});

	it("delivers each settled result while sibling forks are still active", async () => {
		delete process.env.PI_FORK_CHILD;
		const { default: piTinyFork } = await import("../src/index.ts");
		const pi = {
			registerTool: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		};

		piTinyFork(pi as never);
		const fork: ForkSnapshot = {
			id: "fork-1",
			transcriptPath: "/tmp/fork-1.jsonl",
			status: "completed",
			turns: 1,
			lastOutput: "done",
		};
		mocks.managerOptions?.onSettled(fork);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage.mock.calls[0][0].content).toContain("done");
	});
});
