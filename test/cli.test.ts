import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startApi, type ChildRequest } from "../src/api.ts";

const CLI = fileURLToPath(new URL("../bin/pi-child.mjs", import.meta.url));
const SPAWN_TIMEOUT_MS = 10_000;

type Result = { code: number; stdout: string; stderr: string };

function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.PI_FORK_CHILD;
	delete env.PI_CHILD_ENDPOINT;
	delete env.PI_CHILD_TOKEN;
	delete env.PI_CHILD_RUN_ID;
	return env;
}

function runCli(args: string[], extra: Record<string, string> = {}): Promise<Result> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn(process.execPath, [CLI, ...args], { env: { ...baseEnv(), ...extra } });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve({ code: 124, stdout, stderr: `${stderr}timed out` });
		}, SPAWN_TIMEOUT_MS);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

describe("pi-child CLI", () => {
	it("prints help and rejects unknown commands", async () => {
		const help = await runCli(["--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("Usage: pi-child");
		expect((await runCli(["-h"])).code).toBe(0);
		expect((await runCli([])).code).toBe(1);
		const bogus = await runCli(["bogus"]);
		expect(bogus.code).toBe(1);
		expect(bogus.stderr).toContain("unknown command: bogus");
	});

	it("refuses child invocation and missing endpoint/token", async () => {
		const child = await runCli(["status"], { PI_FORK_CHILD: "1" });
		expect(child.code).toBe(1);
		expect(child.stderr).toContain("delegated fork");
		const noEndpoint = await runCli(["status"]);
		expect(noEndpoint.code).toBe(1);
		expect(noEndpoint.stderr).toContain("missing PI_CHILD_ENDPOINT");
		const noToken = await runCli(["status"], { PI_CHILD_ENDPOINT: "nowhere" });
		expect(noToken.code).toBe(1);
		expect(noToken.stderr).toContain("missing PI_CHILD_TOKEN");
	});

	it("validates flags strictly with no context/batch surface", async () => {
		const api = await startApi(async () => null);
		try {
			const extra = { PI_CHILD_ENDPOINT: api.endpoint, PI_CHILD_TOKEN: api.token };
			for (const args of [
				["start", "--task", "t", "--context", "full"],
				["start", "--task", "t", "--batch"],
				["start"],
				["start", "--task", "t", "--thinking", "huge"],
				["run", "echo", "hi"],
				["run", "--"],
				["result"],
				["stop"],
				["steer", "id"],
				["status", "a", "b"],
			]) {
				const result = await runCli(args, extra);
				expect(result.code).toBe(1);
				expect(result.stderr.length).toBeGreaterThan(0);
			}
		} finally {
			await api.close();
		}
	});

	it("wires start/run fields and inherits PI_CHILD_RUN_ID", async () => {
		const seen: ChildRequest[] = [];
		const api = await startApi(async (request) => {
			seen.push(request);
			return { id: "fork-1", status: "running" };
		});
		try {
			const extra = { PI_CHILD_ENDPOINT: api.endpoint, PI_CHILD_TOKEN: api.token };
			let result = await runCli(
				["start", "--task", "héllo 終 🎉", "--cwd", "work", "--model", "p/m", "--thinking", "high"],
				{ ...extra, PI_CHILD_RUN_ID: "run-1" },
			);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ id: "fork-1", status: "running" });
			expect(seen[0]).toEqual({
				op: "start",
				task: "héllo 終 🎉",
				cwd: "work",
				model: "p/m",
				thinkingLevel: "high",
				runId: "run-1",
			});

			result = await runCli(["start", "--task", "plain"], extra);
			expect(result.code).toBe(0);
			expect(seen[1]).toEqual({ op: "start", task: "plain" });

			result = await runCli(["run", "--cwd", "/tmp", "--", "echo", "hi there", "終"], {
				...extra,
				PI_CHILD_RUN_ID: "run-2",
			});
			expect(result.code).toBe(0);
			expect(seen[2]).toEqual({ op: "run", argv: ["echo", "hi there", "終"], cwd: "/tmp", runId: "run-2" });

			result = await runCli(["run", "--", "true"], extra);
			expect(result.code).toBe(0);
			expect(seen[3]).toEqual({ op: "run", argv: ["true"] });
		} finally {
			await api.close();
		}
	});

	it("wires status/result/steer/stop and wait flags", async () => {
		const seen: ChildRequest[] = [];
		const api = await startApi(async (request) => {
			seen.push(request);
			return "done";
		});
		try {
			const extra = { PI_CHILD_ENDPOINT: api.endpoint, PI_CHILD_TOKEN: api.token };
			const cases: Array<{ args: string[]; request: ChildRequest }> = [
				{ args: ["status"], request: { op: "status" } },
				{ args: ["status", "abc"], request: { op: "status", id: "abc" } },
				{ args: ["result", "abc"], request: { op: "result", id: "abc" } },
				{ args: ["result", "abc", "--wait"], request: { op: "result", id: "abc", wait: true } },
				{ args: ["result", "--wait", "abc"], request: { op: "result", id: "abc", wait: true } },
				{ args: ["steer", "abc", "keep", "going 終"], request: { op: "steer", id: "abc", prompt: "keep going 終" } },
				{ args: ["stop", "abc"], request: { op: "stop", id: "abc" } },
			];
			for (const { args, request } of cases) {
				const result = await runCli(args, extra);
				expect(result.code).toBe(0);
				expect(result.stdout).toBe('"done"\n');
				expect(seen.at(-1)).toEqual(request);
			}
		} finally {
			await api.close();
		}
	});

	it("maps manager errors to exit 1 and settled data to exit 0", async () => {
		const api = await startApi(async (request) => {
			if (request.op === "result" && !request.wait) throw new Error("pending: use --wait");
			if (request.op === "status") return { id: "a", status: "failed", error: "boom" };
			return { id: "a", status: "completed" };
		});
		try {
			const extra = { PI_CHILD_ENDPOINT: api.endpoint, PI_CHILD_TOKEN: api.token };
			const pending = await runCli(["result", "a"], extra);
			expect(pending.code).toBe(1);
			expect(pending.stderr).toContain("pending: use --wait");
			const failed = await runCli(["status", "a"], extra);
			expect(failed.code).toBe(0);
			expect(JSON.parse(failed.stdout)).toEqual({ id: "a", status: "failed", error: "boom" });
		} finally {
			await api.close();
		}
	});

	it("waits indefinitely for result --wait", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const api = await startApi(async (request) => {
			if (request.op === "result") await gate;
			return { id: "a", status: "completed" };
		});
		try {
			const child = spawn(process.execPath, [CLI, "result", "a", "--wait"], {
				env: { ...baseEnv(), PI_CHILD_ENDPOINT: api.endpoint, PI_CHILD_TOKEN: api.token },
			});
			let stdout = "";
			let exited: number | undefined;
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.on("data", () => undefined);
			child.on("error", () => undefined);
			child.on("close", (code) => {
				exited = code ?? 1;
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(exited).toBeUndefined();
			release();
			const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? 1)));
			expect(code).toBe(0);
			expect(JSON.parse(stdout)).toEqual({ id: "a", status: "completed" });
		} finally {
			release();
			await api.close();
		}
	}, 15_000);

	it("forwards an explicitly empty run id instead of dropping it", async () => {
		const seen: ChildRequest[] = [];
		const api = await startApi(async (request) => {
			seen.push(request);
			return null;
		});
		try {
			const extra = { PI_CHILD_ENDPOINT: api.endpoint, PI_CHILD_TOKEN: api.token, PI_CHILD_RUN_ID: "" };
			const startEmpty = await runCli(["start", "--task", "t"], extra);
			expect(startEmpty.code).toBe(1);
			expect(startEmpty.stderr).toContain("invalid runId");
			expect(seen).toEqual([]);
			const runEmpty = await runCli(["run", "--", "true"], extra);
			expect(runEmpty.code).toBe(1);
			expect(runEmpty.stderr).toContain("invalid runId");
		} finally {
			await api.close();
		}
	});

	it("decodes split multibyte server responses", async () => {
		const text = "héllo 終 🎉";
		const server = createServer((socket) => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				if (buffer.indexOf("\n") === -1) return;
				const bytes = Buffer.from(`${JSON.stringify({ ok: true, data: { text } })}\n`, "utf8");
				const half = bytes.indexOf(Buffer.from("終")) + 1;
				socket.write(bytes.subarray(0, half));
				setTimeout(() => socket.end(bytes.subarray(half)), 20);
			});
		});
		const dir = process.platform === "win32" ? undefined : mkdtempSync(join(tmpdir(), "pi-child-test-"));
		const endpoint = dir ? join(dir, "fake.sock") : `\\\\.\\pipe\\pi-child-test-${randomUUID()}`;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(endpoint, () => {
					server.off("error", reject);
					resolve();
				});
			});
			const result = await runCli(["status"], { PI_CHILD_ENDPOINT: endpoint, PI_CHILD_TOKEN: "t" });
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ text });
		} finally {
			server.close();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ships portable launchers for the bundled CLI", () => {
		const dir = fileURLToPath(new URL("../bin/", import.meta.url));
		const unix = readFileSync(join(dir, "pi-child"), "utf8");
		expect(unix.split("\n")[0]).toBe("#!/usr/bin/env node");
		expect(unix).toContain("pi-child.mjs");
		expect(unix.split("\n").length).toBeLessThanOrEqual(4);
		const cmd = readFileSync(join(dir, "pi-child.cmd"), "utf8");
		expect(cmd).toContain("pi-child.mjs");
		expect(cmd).toContain("%~dp0");
	});
});
