import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type AssistantMessage,
	type Context,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
		isIdle: vi.fn(() => true),
		sessionManager: { getSessionDir: () => "/tmp/sessions" },
		ui: { setWidget: vi.fn() },
	};
	piTinyFork(pi as never);
	const event = (name: string) => pi.on.mock.calls.find(([type]) => type === name)?.[1];
	await event("session_start")?.({}, ctx);
	cleanups.push(async () => { await event("session_shutdown")?.({}, ctx); });
	const tools = Object.fromEntries(pi.registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
	const deliver = (index = pi.sendMessage.mock.calls.length - 1) => {
		const message = { role: "custom", ...pi.sendMessage.mock.calls[index][0], timestamp: Date.now() };
		event("message_start")({ message }, ctx);
		return { ...message, content: message.content.map((block: { text: string }) => block.text).join("\n") };
	};
	return { pi, ctx, event, tools, deliver };
}

async function setupAgent() {
	vi.stubEnv("PI_FORK_CHILD", "1");
	const { default: piTinyFork } = await import("../src/index.ts");
	const cwd = mkdtempSync(join(tmpdir(), "pi-tiny-fork-delivery-"));
	const settingsManager = SettingsManager.inMemory({
		steeringMode: "one-at-a-time",
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [piTinyFork],
	});
	await resourceLoader.reload();
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(cwd), tools: [],
	});
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: (error) => { errors.push(error); } });
	const requests: Context[] = [];
	const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
	const messageStarts: unknown[] = [];
	session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "custom") {
			messageStarts.push(structuredClone(event.message));
		}
	});
	const finish = (index: number, stopReason: "stop" | "aborted" | "error" = "stop") => {
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content: [{ type: "text", text: "response" }], stopReason, timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			...(stopReason === "error" ? { errorMessage: "429 Too Many Requests" } : {}),
		};
		if (stopReason === "stop") streams[index].push({ type: "done", reason: "stop", message });
		else streams[index].push({ type: "error", reason: stopReason, error: message });
	};
	session.agent.streamFunction = (_model, context, options) => {
		const index = streams.length;
		requests.push(structuredClone(context));
		const stream = createAssistantMessageEventStream();
		streams.push(stream);
		options?.signal?.addEventListener("abort", () => finish(index, "aborted"), { once: true });
		return stream;
	};
	cleanups.push(async () => {
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		rmSync(cwd, { recursive: true, force: true });
		expect(errors).toEqual([]);
	});
	const start = () => session.sendCustomMessage({ customType: "test", content: "work", display: false }, { triggerTurn: true });
	return { session, requests, streams, messageStarts, start, finish, settingsManager };
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
		expect(pi.on.mock.calls.map(([name]) => name)).toEqual(["message_start", "agent_settled", "session_start", "session_shutdown"]);
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
		const { pi, deliver } = await setup();
		const options = mocks.managers[0];
		options.onOutput({ ...mocks.runSnapshot, delivery: "live" }, {
			text: "partial",
			startsWithContinuation: true,
			endsWithPartialLine: true,
		});
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const liveText = deliver().content;
		expect(liveText).toContain("[run-1 · continues previous line · last line incomplete]");
		expect(liveText).toContain("]\npartial");

		options.onOutput({ ...mocks.runSnapshot, delivery: "live", status: "completed", exitCode: 0 }, {
			text: "",
			startsWithContinuation: false,
			endsWithPartialLine: false,
			streamEnded: true,
		});
		const finalText = deliver().content;
		expect(finalText).toContain("[run-1 · status: completed · exit code: 0 · stdout: /tmp/stdout.log · stderr: /tmp/stderr.log]");
		expect(finalText.endsWith("]\n")).toBe(true);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("batches ready output and completions into one queued message", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { pi, event, ctx, deliver } = await setup();
		const options = mocks.managers[0];
		const chunk = { text: "first", startsWithContinuation: false, endsWithPartialLine: false };
		options.onOutput(mocks.runSnapshot, chunk);
		event("message_start")({ message: { role: "user", content: "human steering" } }, ctx);
		event("message_start")({ message: { role: "custom", customType: "other", content: [] } }, ctx);
		options.onOutput({ ...mocks.runSnapshot, id: "run-2" }, { ...chunk, text: "second" });
		const completed = { ...mocks.fork, status: "completed", lastOutput: "review ready" };
		options.onSettled(completed);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
		const batch = deliver();
		expect(batch.content).toContain("[run-1]\nfirst\n[run-2]\nsecond\nFork completed.");
		expect(batch.content).toContain("review ready");
		expect(batch.details).toEqual([completed]);

		options.onOutput(mocks.runSnapshot, { ...chunk, text: "later" });
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		expect(deliver().content).toBe("[run-1]\nlater");
		expect(batch.content).not.toContain("later");
	});

	it("allows new notifications after settling with an undelivered batch", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { pi, event, ctx, deliver } = await setup();
		const options = mocks.managers[0];
		options.onSettled({ ...mocks.fork, lastOutput: "before cancellation" });
		event("agent_settled")({}, ctx);
		expect(pi.sendMessage).toHaveBeenCalledOnce();

		options.onSettled({ ...mocks.fork, lastOutput: "after cancellation" });
		deliver(0);
		options.onSettled({ ...mocks.fork, lastOutput: "another result" });
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const batch = deliver();
		expect(batch.content).toContain("after cancellation");
		expect(batch.content).toContain("another result");
		expect(batch.content).not.toContain("before cancellation");
	});

	it("keeps batches isolated between sessions", async () => {
		vi.stubEnv("PI_FORK_CHILD", "1");
		const first = await setup();
		const second = await setup();
		mocks.managers[0].onSettled({ ...mocks.fork, lastOutput: "first session" });
		mocks.managers[1].onSettled({ ...mocks.fork, lastOutput: "second session" });
		expect(first.deliver().content).not.toContain("second session");
		expect(second.deliver().content).not.toContain("first session");
	});

	it("includes suppression reason and keeps aggregate notifications bounded", async () => {
		vi.stubEnv("PI_FORK_CHILD", "");
		const { deliver } = await setup();
		const options = mocks.managers[0];
		options.onOutput({ ...mocks.runSnapshot, delivery: "live" }, {
			text: "output limit exceeded",
			startsWithContinuation: false,
			endsWithPartialLine: false,
			suppressed: true,
		});
		const suppressed = deliver().content;
		expect(suppressed.split("output limit exceeded")).toHaveLength(2);
		expect(suppressed).toContain("suppressed:");
		expect(suppressed).toContain("stdout log: /tmp/stdout.log");

		options.onSettled({
			...mocks.runSnapshot,
			delivery: "aggregate",
			status: "completed",
			lastOutput: "done".repeat(30_000),
		});
		const aggregate = deliver().content;
		expect(aggregate).toContain("Run completed");
		expect(aggregate).toContain("Stdout: /tmp/stdout.log");
		expect(Buffer.byteLength(aggregate)).toBeLessThan(51 * 1024);
	});
});

describe("batched delivery through AgentSession", () => {
	it("delivers all ready updates together without changing human steering", async () => {
		const { session, requests, streams, messageStarts, start, finish } = await setupAgent();
		const active = start();
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		await session.steer("human one");
		const options = mocks.managers[0];
		for (let i = 0; i < 25; i++) {
			options.onOutput({ ...mocks.runSnapshot, id: `run-${i % 2}` }, {
				text: `chunk ${i}`, startsWithContinuation: false, endsWithPartialLine: false,
			});
		}
		await session.steer("human two");
		finish(0);
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		expect(JSON.stringify(requests[1])).toContain("human one");
		expect(JSON.stringify(requests[1])).not.toContain("human two");
		expect(JSON.stringify(requests[1])).not.toContain("chunk 0");

		options.onSettled({ ...mocks.fork, status: "completed", lastOutput: "review ready" });
		finish(1);
		await vi.waitFor(() => expect(streams).toHaveLength(3));
		const delivered = JSON.stringify(requests[2]);
		for (let i = 0; i < 25; i++) expect(delivered).toContain(`chunk ${i}`);
		expect(delivered).toContain("review ready");
		expect(delivered).not.toContain("human two");
		const entries = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-tiny-fork");
		expect(entries).toHaveLength(1);
		expect(JSON.stringify(entries[0])).toContain("review ready");
		expect(JSON.stringify(messageStarts)).toContain("review ready");
		expect(session.agent.steeringMode).toBe("one-at-a-time");

		finish(2);
		await vi.waitFor(() => expect(streams).toHaveLength(4));
		expect(JSON.stringify(requests[3])).toContain("human two");
		finish(3);
		await active;
		expect(streams).toHaveLength(4);
	});

	it("wakes an idle session once for arrivals before delivery", async () => {
		const { session, requests, streams, finish } = await setupAgent();
		const options = mocks.managers[0];
		options.onOutput(mocks.runSnapshot, { text: "output", startsWithContinuation: false, endsWithPartialLine: false });
		options.onSettled({ ...mocks.fork, status: "completed", lastOutput: "review ready" });
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		expect(JSON.stringify(requests[0])).toContain("output");
		expect(JSON.stringify(requests[0])).toContain("review ready");
		finish(0);
		await vi.waitFor(() => expect(session.isIdle).toBe(true));
		expect(streams).toHaveLength(1);
	});

	it("does not requeue cancelled output or block later completions", async () => {
		const { session, requests, streams, start, finish } = await setupAgent();
		const active = start();
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const options = mocks.managers[0];
		options.onSettled({ ...mocks.fork, lastOutput: "cancelled result" });
		session.clearQueue();
		await session.abort();
		await active;
		expect(session.isIdle).toBe(true);
		expect(streams).toHaveLength(1);

		options.onSettled({ ...mocks.fork, lastOutput: "new result" });
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		expect(JSON.stringify(requests[1])).toContain("new result");
		expect(JSON.stringify(requests[1])).not.toContain("cancelled result");
		finish(1);
		await vi.waitFor(() => expect(session.isIdle).toBe(true));
		expect(streams).toHaveLength(2);
	});

	it("keeps one pending batch across automatic retries", async () => {
		const { session, requests, streams, start, finish, settingsManager } = await setupAgent();
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
		const active = start();
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		const options = mocks.managers[0];
		options.onSettled({ ...mocks.fork, lastOutput: "first result" });
		finish(0, "error");
		options.onSettled({ ...mocks.fork, lastOutput: "second result" });
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		expect(JSON.stringify(requests[1])).toContain("first result");
		expect(JSON.stringify(requests[1])).toContain("second result");
		finish(1);
		await active;
		expect(streams).toHaveLength(2);
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-tiny-fork")).toHaveLength(1);
	});
});
