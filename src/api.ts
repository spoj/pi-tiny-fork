import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

export type ChildRequest =
	| { op: "start"; task: string; cwd?: string; model?: string; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; runId?: string }
	| { op: "run"; argv: string[]; cwd?: string; runId?: string }
	| { op: "status"; id?: string }
	| { op: "result"; id: string; wait?: boolean }
	| { op: "steer"; id: string; prompt: string }
	| { op: "stop"; id: string };

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FIELDS: Record<string, Set<string>> = {
	start: new Set(["task", "cwd", "model", "thinkingLevel", "runId"]),
	run: new Set(["argv", "cwd", "runId"]),
	status: new Set(["id"]),
	result: new Set(["id", "wait"]),
	steer: new Set(["id", "prompt"]),
	stop: new Set(["id"]),
};

function fail(socket: Socket, error: string): void {
	if (!socket.destroyed && socket.writable) {
		socket.end(`${JSON.stringify({ ok: false, error })}\n`);
	} else {
		socket.destroy();
	}
}

function validateOp(value: Record<string, unknown>): ChildRequest {
	if (typeof value.op !== "string") throw new Error("invalid op");
	if (!Object.hasOwn(FIELDS, value.op)) throw new Error("unknown op");
	const fields = FIELDS[value.op];
	for (const key of Object.keys(value)) {
		if (key !== "op" && !fields.has(key)) throw new Error(`unknown field: ${key}`);
	}
	switch (value.op) {
		case "start":
			if (typeof value.task !== "string" || value.task.length === 0) throw new Error("start requires task");
			if (value.cwd !== undefined && typeof value.cwd !== "string") throw new Error("invalid cwd");
			if (value.model !== undefined && typeof value.model !== "string") throw new Error("invalid model");
			if (value.thinkingLevel !== undefined && (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel))) {
				throw new Error("invalid thinkingLevel");
			}
			if (value.runId !== undefined && (typeof value.runId !== "string" || value.runId.length === 0)) throw new Error("invalid runId");
			return value as unknown as ChildRequest;
		case "run":
			if (!Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((entry) => typeof entry === "string") || !value.argv[0]) {
				throw new Error("run requires argv");
			}
			if (value.cwd !== undefined && typeof value.cwd !== "string") throw new Error("invalid cwd");
			if (value.runId !== undefined && (typeof value.runId !== "string" || value.runId.length === 0)) throw new Error("invalid runId");
			return value as unknown as ChildRequest;
		case "status":
			if (value.id !== undefined && typeof value.id !== "string") throw new Error("invalid id");
			return value as unknown as ChildRequest;
		case "result":
			if (typeof value.id !== "string" || value.id.length === 0) throw new Error("result requires id");
			if (value.wait !== undefined && typeof value.wait !== "boolean") throw new Error("invalid wait");
			return value as unknown as ChildRequest;
		case "steer":
			if (typeof value.id !== "string" || value.id.length === 0) throw new Error("steer requires id");
			if (typeof value.prompt !== "string" || value.prompt.length === 0) throw new Error("steer requires prompt");
			return value as unknown as ChildRequest;
		case "stop":
			if (typeof value.id !== "string" || value.id.length === 0) throw new Error("stop requires id");
			return value as unknown as ChildRequest;
		default:
			throw new Error("unknown op");
	}
}

export async function startApi(
	handler: (request: ChildRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<{ endpoint: string; token: string; close(): Promise<void> }> {
	const token = randomBytes(32).toString("hex");
	const server = createServer();
	const sockets = new Set<Socket>();
	let dir: string | undefined;
	let endpoint: string;
	if (process.platform === "win32") {
		endpoint = `\\\\.\\pipe\\pi-child-${randomUUID()}`;
	} else {
		const root = Buffer.byteLength(join(tmpdir(), "pi-child-XXXXXX", "api.sock")) < MAX_UNIX_SOCKET_PATH_BYTES ? tmpdir() : "/tmp";
		dir = mkdtempSync(join(root, "pi-child-"));
		endpoint = join(dir, "api.sock");
	}

	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		let settled = false;
		let buffer = Buffer.alloc(0);
		const controller = new AbortController();
		const onClose = (): void => {
			if (!controller.signal.aborted) controller.abort();
			sockets.delete(socket);
		};
		socket.on("close", onClose);
		socket.on("error", () => undefined);
		socket.on("data", (chunk: Buffer) => {
			if (settled) return;
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > MAX_REQUEST_BYTES + 1) {
				settled = true;
				fail(socket, "request too large");
				return;
			}
			const newline = buffer.indexOf(10);
			if (newline === -1) return;
			settled = true;
			let line = buffer.subarray(0, newline);
			if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
			if (line.length > MAX_REQUEST_BYTES) {
				fail(socket, "request too large");
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(line.toString("utf8"));
			} catch {
				fail(socket, "invalid JSON");
				return;
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				fail(socket, "invalid request");
				return;
			}
			const record = value as Record<string, unknown>;
			if (record.token !== token) {
				fail(socket, "invalid token");
				return;
			}
			const { token: _ignored, ...rest } = record;
			let request: ChildRequest;
			try {
				request = validateOp(rest);
			} catch (error) {
				fail(socket, error instanceof Error ? error.message : String(error));
				return;
			}
			void (async () => {
				try {
					const data = await handler(request, controller.signal);
					if (socket.destroyed || socket.closed) return;
					socket.end(`${JSON.stringify({ ok: true, data })}\n`);
				} catch (error) {
					if (socket.destroyed || socket.closed) return;
					const message = error instanceof Error ? error.message : String(error);
					socket.end(`${JSON.stringify({ ok: false, error: message || "request failed" })}\n`);
				}
			})();
		});
	});

	try {
		if (dir) chmodSync(dir, 0o700);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(endpoint, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		if (dir) rmSync(dir, { recursive: true, force: true });
		throw error;
	}

	let closePromise: Promise<void> | undefined;
	function close(): Promise<void> {
		closePromise ??= (async () => {
			for (const socket of [...sockets]) socket.destroy();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			if (dir) rmSync(dir, { recursive: true, force: true });
		})();
		return closePromise;
	}

	return { endpoint, token, close };
}
