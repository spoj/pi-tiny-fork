import { connect } from "node:net";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startApi, type ChildRequest } from "../src/api.ts";

const TIMEOUT_MS = 5_000;

function sendRaw(endpoint: string, chunks: Array<string | Buffer>): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(endpoint);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("timed out waiting for response"));
		}, TIMEOUT_MS);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline !== -1) {
				clearTimeout(timer);
				const line = buffer.slice(0, newline);
				socket.end();
				resolve(line);
			}
		});
		socket.on("connect", () => {
			for (const chunk of chunks) socket.write(chunk);
		});
	});
}

async function call(
	endpoint: string,
	token: string,
	payload: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	return JSON.parse(await sendRaw(endpoint, [`${JSON.stringify({ token, ...payload })}\n`])) as {
		ok: boolean;
		data?: unknown;
		error?: string;
	};
}

describe("local API transport", () => {
	it("round-trips every op to the handler and answers LF-terminated JSON", async () => {
		const seen: ChildRequest[] = [];
		const api = await startApi(async (request) => {
			seen.push(request);
			return { echo: request.op };
		});
		try {
			const requests: Record<string, unknown>[] = [
				{ op: "start", task: "work", cwd: "/tmp", model: "p/m", thinkingLevel: "high", runId: "r1" },
				{ op: "run", argv: ["echo", "hi"], cwd: "/tmp", runId: "r1" },
				{ op: "status" },
				{ op: "status", id: "a" },
				{ op: "result", id: "a", wait: true },
				{ op: "steer", id: "a", prompt: "go" },
				{ op: "stop", id: "a" },
			];
			for (const payload of requests) {
				const raw = await sendRaw(api.endpoint, [`${JSON.stringify({ token: api.token, ...payload })}\n`]);
				expect(JSON.parse(raw)).toEqual({ ok: true, data: { echo: payload.op } });
			}
			expect(seen.map((request) => request.op)).toEqual(requests.map((request) => request.op));
		} finally {
			await api.close();
		}
	});

	it("serves concurrent requests while one waits", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const api = await startApi(async (request) => {
			if (request.op === "result") await gate;
			return { op: request.op };
		});
		try {
			const waiting = call(api.endpoint, api.token, { op: "result", id: "a", wait: true });
			expect(await call(api.endpoint, api.token, { op: "status" })).toEqual({
				ok: true,
				data: { op: "status" },
			});
			expect(await call(api.endpoint, api.token, { op: "status", id: "a" })).toEqual({
				ok: true,
				data: { op: "status" },
			});
			release();
			expect(await waiting).toEqual({ ok: true, data: { op: "result" } });
		} finally {
			release();
			await api.close();
		}
	});

	it("rejects bad auth, malformed JSON, unknown ops, and invalid options", async () => {
		const api = await startApi(async () => "unreachable");
		try {
			expect(await call(api.endpoint, "wrong-token", { op: "status" })).toEqual({
				ok: false,
				error: "invalid token",
			});
			expect(JSON.parse(await sendRaw(api.endpoint, [`${JSON.stringify({ op: "status" })}\n`]))).toEqual({
				ok: false,
				error: "invalid token",
			});
			expect(JSON.parse(await sendRaw(api.endpoint, ["{oops\n"]))).toEqual({
				ok: false,
				error: "invalid JSON",
			});
			for (const payload of [
				{ op: "bogus" },
				{ op: "constructor", id: "a" },
				{ op: "__proto__", id: "a" },
				{ op: "start" },
				{ op: "start", task: "" },
				{ op: "start", task: "t", thinkingLevel: "huge" },
				{ op: "run", argv: [] },
				{ op: "run", argv: [""] },
				{ op: "run", argv: "echo" },
				{ op: "result" },
				{ op: "result", id: "a", wait: "yes" },
				{ op: "steer", id: "a" },
				{ op: "stop" },
				{ op: "status", id: 42 },
			]) {
				const response = await call(api.endpoint, api.token, payload as Record<string, unknown>);
				expect(response.ok).toBe(false);
				expect(typeof response.error).toBe("string");
			}
			expect(await call(api.endpoint, api.token, { op: "status" })).toEqual({
				ok: true,
				data: "unreachable",
			});
		} finally {
			await api.close();
		}
	});

	it("bounds request size", async () => {
		const api = await startApi(async () => "unreachable");
		try {
			const big = `${JSON.stringify({ token: api.token, op: "status", pad: "x".repeat(1024 * 1024) })}\n`;
			expect(JSON.parse(await sendRaw(api.endpoint, [big]))).toEqual({
				ok: false,
				error: "request too large",
			});
			expect(await call(api.endpoint, api.token, { op: "status" })).toEqual({
				ok: true,
				data: "unreachable",
			});
		} finally {
			await api.close();
		}
	});

	it("aborts the handler signal when the client disconnects", async () => {
		let observed: boolean | undefined;
		const api = await startApi(async (_request, signal) => {
			await new Promise<void>((resolve) => {
				if (signal.aborted) {
					observed = true;
					resolve();
				} else {
					signal.addEventListener("abort", () => {
						observed = true;
						resolve();
					}, { once: true });
				}
			});
			return "done";
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const socket = connect(api.endpoint);
				socket.on("error", reject);
				socket.on("connect", () => {
					socket.write(`${JSON.stringify({ token: api.token, op: "result", id: "a", wait: true })}\n`);
					setTimeout(() => {
						socket.destroy();
						resolve();
					}, 50);
				});
			});
			await vi.waitFor(() => expect(observed).toBe(true));
		} finally {
			await api.close();
		}
	});

	it("frames split multibyte writes and Unicode payloads", async () => {
		const api = await startApi(async (request) => request);
		try {
			const payload = `${JSON.stringify({ token: api.token, op: "start", task: "héllo 終 🎉 \n tab\there" })}\n`;
			const bytes = Buffer.from(payload, "utf8");
			const half = bytes.indexOf(Buffer.from("終")) + 1;
			const response = JSON.parse(
				await sendRaw(api.endpoint, [bytes.subarray(0, half), bytes.subarray(half)]),
			) as { ok: boolean; data: { task: string } };
			expect(response.ok).toBe(true);
			expect(response.data.task).toBe("héllo 終 🎉 \n tab\there");
		} finally {
			await api.close();
		}
	});

	it("uses a per-session token and cleans up on idempotent close", async () => {
		const first = await startApi(async () => "one");
		const second = await startApi(async () => "two");
		try {
			expect(first.token).not.toBe(second.token);
			if (process.platform === "win32") {
				expect(first.endpoint.startsWith("\\\\.\\pipe\\pi-child-")).toBe(true);
			} else {
				expect(existsSync(first.endpoint)).toBe(true);
				expect(statSync(dirname(first.endpoint)).mode & 0o777).toBe(0o700);
			}
			expect(await call(first.endpoint, first.token, { op: "status" })).toEqual({ ok: true, data: "one" });
			expect(await call(first.endpoint, second.token, { op: "status" })).toEqual({
				ok: false,
				error: "invalid token",
			});
		} finally {
			await first.close();
			await first.close();
			await second.close();
		}
		if (process.platform !== "win32") expect(existsSync(first.endpoint)).toBe(false);
		await expect(call(first.endpoint, first.token, { op: "status" })).rejects.toThrow();
	});

	it("rejects unknown/stale request fields", async () => {
		const api = await startApi(async () => "unreachable");
		try {
			expect(await call(api.endpoint, api.token, { op: "start", task: "t", context: "full" })).toEqual({
				ok: false,
				error: "unknown field: context",
			});
			expect(await call(api.endpoint, api.token, { op: "status", context: "full" })).toEqual({
				ok: false,
				error: "unknown field: context",
			});
			expect(await call(api.endpoint, api.token, { op: "run", argv: ["echo"], batch: true })).toEqual({
				ok: false,
				error: "unknown field: batch",
			});
		} finally {
			await api.close();
		}
	});
});
