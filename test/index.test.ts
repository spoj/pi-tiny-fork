import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

const mocks = vi.hoisted(() => {
	const runSnapshot = {
		id: "run-1",
		argv: ["sh", "-c", "work"],
		cwd: "/tmp/parent",
		stdoutPath: "/tmp/stdout.log",
		stderrPath: "/tmp/stderr.log",
		status: "running",
	};
	const run = vi.fn(async (_argv: string[], _options: unknown) => runSnapshot);
	const stop = vi.fn(async (_id: string) => ({ ...runSnapshot, status: "stopped" }));
	const shutdown = vi.fn(async () => undefined);
	const managers: Array<{ sessionDir: string; onOutput: (run: any, chunk: any) => void }> = [];
	class FakeManager {
		constructor(options: (typeof managers)[number]) { managers.push(options); }
		list() { return []; }
		run = run;
		stop = stop;
		shutdown = shutdown;
	}
	return { FakeManager, runSnapshot, run, stop, shutdown, managers };
});

vi.mock("../src/manager.ts", () => ({ MonitorManager: mocks.FakeManager }));

function output(text: string, id = "run-1") {
	mocks.managers.at(-1)!.onOutput({ ...mocks.runSnapshot, id }, { text, startsWithContinuation: false, endsWithPartialLine: false });
}

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
});

describe("monitor extension", () => {
	it("registers only the monitor tools and no system prompt hook", async () => {
		const { pi, tools } = await setup();
		expect(Object.keys(tools)).toEqual(["monitor", "monitor_stop"]);
		expect(tools.monitor.parameters.required).toEqual(["command"]);
		expect(tools.monitor_stop.parameters.required).toEqual(["id"]);
		expect(pi.on.mock.calls.map(([name]) => name)).toEqual(["message_start", "agent_settled", "session_start", "session_shutdown"]);
		expect(mocks.managers[0]).toMatchObject({ sessionDir: "/tmp/sessions" });
	});

	it("starts monitors in the session cwd", async () => {
		const { tools } = await setup();
		const result = await tools.monitor.execute("call-1", { command: "printf hello" }, undefined, undefined, {
			cwd: "/tmp/parent",
			isProjectTrusted: () => true,
		} as never);
		expect(mocks.run).toHaveBeenCalledOnce();
		expect(mocks.run.mock.calls[0][1]).toMatchObject({ cwd: "/tmp/parent" });
		expect(result.content[0].text).toContain("Monitor started");
	});

	it("stops monitors by ID", async () => {
		const { tools } = await setup();
		const result = await tools.monitor_stop.execute("call-1", { id: "run-1" });
		expect(mocks.stop).toHaveBeenCalledWith("run-1");
		expect(result.content[0].text).toContain("Monitor stopped");
	});

	it("documents timed chunk boundaries and pi-sub delegation", async () => {
		const { tools } = await setup();
		const guidelines = tools.monitor.promptGuidelines.join(" ");
		expect(guidelines).toContain("not newline boundaries");
		expect(guidelines).toContain("pi-sub");
	});

	it("puts pi-sub on PATH for the session and restores PATH once", async () => {
		const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		vi.stubEnv(pathKey, "/original");
		const { event, ctx } = await setup();
		const [bin, rest] = process.env[pathKey]!.split(delimiter);
		expect(existsSync(join(bin, "pi-sub"))).toBe(true);
		expect(rest).toBe("/original");
		await event("session_shutdown")({}, ctx);
		await event("session_shutdown")({}, ctx);
		expect(mocks.shutdown).toHaveBeenCalledOnce();
		expect(process.env[pathKey]).toBe("/original");
	});

	it("delivers live flags and final log paths", async () => {
		const { pi, deliver } = await setup();
		const options = mocks.managers[0];
		options.onOutput(mocks.runSnapshot, {
			text: "partial",
			startsWithContinuation: true,
			endsWithPartialLine: true,
		});
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const liveText = deliver().content;
		expect(liveText).toContain("[run-1 · continues previous line · last line incomplete]");
		expect(liveText).toContain("]\npartial");

		options.onOutput({ ...mocks.runSnapshot, status: "completed", exitCode: 0 }, {
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

	it("batches ready output into one queued message", async () => {
		const { pi, event, ctx, deliver } = await setup();
		output("first");
		event("message_start")({ message: { role: "user", content: "human steering" } }, ctx);
		event("message_start")({ message: { role: "custom", customType: "other", content: [] } }, ctx);
		output("second", "run-2");

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
		const batch = deliver();
		expect(batch.content).toBe("[run-1]\nfirst\n[run-2]\nsecond");

		output("later");
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		expect(deliver().content).toBe("[run-1]\nlater");
		expect(batch.content).not.toContain("later");
	});

	it("allows new notifications after settling with an undelivered batch", async () => {
		const { pi, event, ctx, deliver } = await setup();
		output("before cancellation");
		event("agent_settled")({}, ctx);
		expect(pi.sendMessage).toHaveBeenCalledOnce();

		output("after cancellation");
		deliver(0);
		output("another result");
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const batch = deliver();
		expect(batch.content).toContain("after cancellation");
		expect(batch.content).toContain("another result");
		expect(batch.content).not.toContain("before cancellation");
	});

	it("keeps batches isolated between sessions", async () => {
		const first = await setup();
		const second = await setup();
		mocks.managers[0].onOutput(mocks.runSnapshot, { text: "first session", startsWithContinuation: false, endsWithPartialLine: false });
		mocks.managers[1].onOutput(mocks.runSnapshot, { text: "second session", startsWithContinuation: false, endsWithPartialLine: false });
		expect(first.deliver().content).not.toContain("second session");
		expect(second.deliver().content).not.toContain("first session");
	});

	it("includes the suppression reason once with the stdout log", async () => {
		const { deliver } = await setup();
		mocks.managers[0].onOutput(mocks.runSnapshot, {
			text: "output limit exceeded",
			startsWithContinuation: false,
			endsWithPartialLine: false,
			suppressed: true,
		});
		const suppressed = deliver().content;
		expect(suppressed.split("output limit exceeded")).toHaveLength(2);
		expect(suppressed).toContain("suppressed:");
		expect(suppressed).toContain("stdout log: /tmp/stdout.log");
	});
});

describe("batched delivery through AgentSession", () => {
	it("delivers all ready updates together without changing human steering", async () => {
		const { session, requests, streams, messageStarts, start, finish } = await setupAgent();
		const active = start();
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		await session.steer("human one");
		for (let i = 0; i < 25; i++) output(`chunk ${i}`, `run-${i % 2}`);
		await session.steer("human two");
		finish(0);
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		expect(JSON.stringify(requests[1])).toContain("human one");
		expect(JSON.stringify(requests[1])).not.toContain("human two");
		expect(JSON.stringify(requests[1])).not.toContain("chunk 0");

		output("review ready");
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
		output("output");
		output("review ready");
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
		output("cancelled result");
		session.clearQueue();
		await session.abort();
		await active;
		expect(session.isIdle).toBe(true);
		expect(streams).toHaveLength(1);

		output("new result");
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
		output("first result");
		finish(0, "error");
		output("second result");
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		expect(JSON.stringify(requests[1])).toContain("first result");
		expect(JSON.stringify(requests[1])).toContain("second result");
		finish(1);
		await active;
		expect(streams).toHaveLength(2);
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-tiny-fork")).toHaveLength(1);
	});
});
