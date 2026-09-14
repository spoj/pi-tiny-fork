import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piInvocation, RpcChild, type ChildExit } from "../src/rpc.ts";
import { createForkSession } from "../src/fork.ts";

type RpcChildInternals = {
	process: object | undefined;
	pid: number;
	consumeStdout: (chunk: Buffer) => void;
	flushStdout: () => void;
	handleExit: (exit: ChildExit) => void;
	processLine: (line: string) => void;
	appendStderr: (chunk: Buffer | string) => void;
	request: (command: Record<string, unknown>) => Promise<unknown>;
};

function useFakePi(directory: string, script: string): string {
	const packageDir = join(directory, "pi-package");
	const entrypoint = join(packageDir, "dist", "bundle", "cli.js");
	mkdirSync(join(packageDir, "dist", "bundle"), { recursive: true });
	copyFileSync(script, entrypoint);
	vi.stubEnv("PI_PACKAGE_DIR", packageDir);
	return entrypoint;
}

afterEach(() => vi.unstubAllEnvs());

describe("RPC child", () => {
	it("resolves the bundled Pi CLI from the package", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-package-"));
		try {
			const cli = useFakePi(directory, import.meta.filename);
			expect(piInvocation(["--mode", "rpc"])).toEqual({ command: process.execPath, args: [cli, "--mode", "rpc"] });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each(["gpt-5", "/gpt-5", "openai/"])("rejects a model without provider/model-id: %s", async (model) => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl", { model, thinkingLevel: "high" });
		await expect(child.start()).rejects.toThrow("exact provider/model-id");
		expect(child.isAlive()).toBe(false);
	});

	it.each([undefined, "set_model", "set_thinking_level"])("configures via RPC before prompting (failure: %s)", async (failure) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tiny-fork-rpc-"));
		const script = join(directory, "child.cjs");
		const log = join(directory, "commands.jsonl");
		const sessionFile = join(directory, "session.jsonl");
		writeFileSync(script, `
			const fs = require("node:fs");
			const log = ${JSON.stringify(log)};
			fs.writeFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
			let pending = false;
			require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
				const command = JSON.parse(line);
				fs.appendFileSync(log, line + "\\n");
				const success = !pending && command.type !== ${JSON.stringify(failure)};
				pending = true;
				setTimeout(() => {
					pending = false;
					console.log(JSON.stringify({ type: "response", id: command.id, command: command.type, success, error: "configuration failed" }));
				}, 20);
			});
		`);
		const child = new RpcChild(directory, sessionFile, { model: "provider/family/model", thinkingLevel: "high" });
		try {
			useFakePi(directory, script);
			const starting = child.start().then(() => child.prompt("work"));
			if (failure) await expect(starting).rejects.toThrow("configuration failed");
			else await starting;

			const [args, ...commands] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(args).toEqual(["--mode", "rpc", "--session", sessionFile]);
			const expected = [
				{ type: "set_model", provider: "provider", modelId: "family/model" },
				{ type: "set_thinking_level", level: "high" },
				{ type: "prompt", message: "work" },
			];
			expect(commands.map(({ id, ...command }) => command)).toEqual(
				failure ? expected.slice(0, failure === "set_model" ? 1 : 2) : expected,
			);
		} finally {
			await child.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["low", "high"] as const)("persists explicit model and %s thinking in a fresh session before prompting", async (thinkingLevel) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tiny-fork-fresh-"));
		writeFileSync(join(directory, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test-key" } }));
		writeFileSync(join(directory, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5-mini", defaultThinkingLevel: "low" }));
		const sessionFile = createForkSession(directory, join(directory, "transcripts"));
		const child = new RpcChild(directory, sessionFile, { model: "openai/gpt-5", thinkingLevel });
		try {
			vi.stubEnv("PI_CODING_AGENT_DIR", directory);
			vi.stubEnv("PI_OFFLINE", "1");
			await child.start();
			expect(await (child as unknown as RpcChildInternals).request({ type: "get_state" })).toMatchObject({
				model: { provider: "openai", id: "gpt-5" }, thinkingLevel, messageCount: 0,
			});
			await child.stop();
			expect(SessionManager.open(sessionFile).buildSessionContext()).toMatchObject({
				model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel, messages: [],
			});
		} finally {
			await child.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);

	it("does not expose any manager credentials or run metadata to agent processes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tiny-fork-env-"));
		const script = join(directory, "child.cjs");
		const log = join(directory, "env.json");
		writeFileSync(script, `
			require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({
				child: process.env.PI_FORK_CHILD,
				keys: Object.keys(process.env).filter(key => key.toUpperCase().startsWith("PI_CHILD_")),
				normal: process.env.FORK_TEST_SETTING
			}));
			process.stdin.resume();
		`);
		const child = new RpcChild(directory, join(directory, "session.jsonl"));
		try {
			for (const key of ["PI_CHILD_ENDPOINT", "PI_CHILD_TOKEN", "PI_CHILD_RUN_ID", "PI_CHILD_CLI", "PI_CHILD_NODE", "pi_child_extra"]) vi.stubEnv(key, "private");
			vi.stubEnv("FORK_TEST_SETTING", "preserved");
			useFakePi(directory, script);
			await child.start();
			await expect.poll(() => existsSync(log)).toBe(true);
			expect(JSON.parse(readFileSync(log, "utf8"))).toEqual({ child: "1", keys: [], normal: "preserved" });
		} finally {
			await child.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("can stop immediately before the spawn event records the PID", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tiny-fork-start-"));
		const script = join(directory, "child.cjs");
		writeFileSync(script, "setInterval(() => {}, 1000);");
		const child = new RpcChild(directory, join(directory, "session.jsonl"));
		try {
			useFakePi(directory, script);
			const starting = child.start();
			const stopping = child.stop();
			await starting;
			await stopping;
			await expect.poll(() => { try { process.kill(child.getPid(), 0); return true; } catch { return false; } }).toBe(false);
		} finally {
			await child.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("flushes a pending decoder tail when stdout ends", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		const lines: string[] = [];

		internals.process = {};
		internals.processLine = (line) => lines.push(line);
		internals.consumeStdout(Buffer.from([0xc3]));
		internals.flushStdout();

		expect(lines).toEqual(["�"]);
	});

	it.each(["null", "true", "42", '"text"', "[]", "{}", '{"type":5}'])(
		"ignores a non-record RPC line: %s",
		(line) => {
			const child = new RpcChild("/tmp", "/tmp/session.jsonl");
			const internals = child as unknown as RpcChildInternals;
			const events: unknown[] = [];
			child.onEvent((event) => events.push(event));
			internals.process = {};

			expect(() => internals.processLine(line)).not.toThrow();
			expect(events).toEqual([]);
		},
	);

	it("keeps dispatching records after a malformed line", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		const events: unknown[] = [];
		child.onEvent((event) => events.push(event));
		internals.process = {};

		internals.processLine("null");
		internals.processLine(JSON.stringify({ type: "turn_start" }));

		expect(events).toEqual([{ type: "turn_start" }]);
	});

	it("bounds stderr while retaining its newest text", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;

		internals.appendStderr(Buffer.alloc(64 * 1024, "x"));
		internals.appendStderr("newest:終");

		expect(Buffer.byteLength(child.getStderr())).toBeLessThanOrEqual(64 * 1024);
		expect(child.getStderr()).toMatch(/newest:終$/);
	});

	it("preserves multibyte stderr split across chunks", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;

		const bytes = Buffer.from("終");
		internals.appendStderr(bytes.subarray(0, 1));
		internals.appendStderr(bytes.subarray(1));

		expect(child.getStderr()).toBe("終");
	});

	it("retains the spawned process ID after exit", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		internals.pid = 1234;
		internals.process = { exitCode: null };

		internals.handleExit({ code: 0, signal: null });

		expect(child.getPid()).toBe(1234);
	});

	it("stops tracking a child when it exits before its stdio closes", () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		internals.process = { exitCode: null };

		internals.handleExit({ code: 1, signal: null });

		expect(child.isAlive()).toBe(false);
	});

	it("destroys all streams when stopping after the child exits", async () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		const stdin = { destroy: vi.fn() };
		const stdout = { destroy: vi.fn() };
		const stderr = { destroy: vi.fn() };
		internals.process = { exitCode: 1, signalCode: null, stdin, stdout, stderr, kill: vi.fn() } as never;

		internals.handleExit({ code: 1, signal: null });
		await child.stop();

		expect(stdin.destroy).toHaveBeenCalledOnce();
		expect(stdout.destroy).toHaveBeenCalledOnce();
		expect(stderr.destroy).toHaveBeenCalledOnce();
	});

	it("drains queued stdout before notifying exit listeners without waiting for stream close", async () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		const events: unknown[] = [];
		const exits: ChildExit[] = [];
		child.onEvent((event) => events.push(event));
		child.onExit((exit) => exits.push(exit));
		internals.process = {};
		internals.handleExit({ code: 1, signal: null });

		internals.processLine(JSON.stringify({ type: "turn_start" }));

		expect(events).toEqual([{ type: "turn_start" }]);
		expect(exits).toEqual([]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(exits).toEqual([{ code: 1, signal: null }]);
	});

	it("drains stderr before notifying exit listeners", async () => {
		const child = new RpcChild("/tmp", "/tmp/session.jsonl");
		const internals = child as unknown as RpcChildInternals;
		let stderrAtExit = "";
		child.onExit(() => {
			stderrAtExit = child.getStderr();
		});
		internals.process = {};
		internals.handleExit({ code: 1, signal: null });
		internals.appendStderr("diagnostic");

		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(stderrAtExit).toBe("diagnostic");
	});

	it.skipIf(process.platform === "win32")("stops the process group after the leader has exited", async () => {
		vi.useFakeTimers();
		const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
			if (signal === 0) {
				const error = new Error("group still exists") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return true;
		}) as never);
		try {
			const child = new RpcChild("/tmp", "/tmp/session.jsonl");
			const internals = child as unknown as RpcChildInternals;
			internals.pid = 1234;
			internals.process = undefined;

			const stopping = child.stop();
			await vi.advanceTimersByTimeAsync(1000);
			await stopping;

			expect(kill.mock.calls.map(([pid, signal]) => [pid, signal]).filter(([, signal]) => signal !== 0)).toEqual([
				[-1234, "SIGTERM"],
				[-1234, "SIGKILL"],
			]);
		} finally {
			kill.mockRestore();
			vi.useRealTimers();
		}
	});

	it.skipIf(process.platform === "win32")("kills an ignored-SIGTERM descendant after the leader exits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tiny-fork-"));
		const marker = join(directory, "leaked");
		const ready = join(directory, "ready");
		const script = join(directory, "rpc-child.cjs");
		const descendant = [
			"const fs = require('node:fs');",
			"process.on('SIGTERM', () => {});",
			`fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
			`setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'leaked'), 1500);`,
		].join(" ");
		writeFileSync(
			script,
			[
				"const { spawn } = require('node:child_process');",
			`spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }).unref();`,
			"setTimeout(() => process.exit(0), 100);",
			].join(" "),
		);

		let child: RpcChild | undefined;
		try {
			useFakePi(directory, script);
			child = new RpcChild(directory, join(directory, "session.jsonl"));
			const exited = new Promise<void>((resolve) => child!.onExit(() => resolve()));
			await child.start();
			await expect.poll(() => existsSync(ready), { timeout: 5_000 }).toBe(true);
			await exited;
			await child.stop();
			await new Promise((resolve) => setTimeout(resolve, 1800));
			expect(existsSync(marker)).toBe(false);
		} finally {
			await child?.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("resolves one concurrent stop after a forced kill even if stdio never closes", async () => {
		vi.useFakeTimers();
		try {
			const child = new RpcChild("/tmp", "/tmp/session.jsonl");
			const internals = child as unknown as RpcChildInternals;
			const signals: NodeJS.Signals[] = [];
			const stdin = { destroy: vi.fn() };
			const stdout = { destroy: vi.fn() };
			const stderr = { destroy: vi.fn() };
			internals.process = {
				exitCode: null,
				stdin,
				stdout,
				stderr,
				once: () => undefined,
				kill: (signal: NodeJS.Signals) => signals.push(signal),
			} as never;

			const stopping = child.stop();
			expect(child.stop()).toBe(stopping);
			await vi.advanceTimersByTimeAsync(1000);
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
			await stopping;
			expect(stdin.destroy).toHaveBeenCalledOnce();
			expect(stdout.destroy).toHaveBeenCalledOnce();
			expect(stderr.destroy).toHaveBeenCalledOnce();
			expect(child.isAlive()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
