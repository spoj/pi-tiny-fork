import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getPackageDir, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ForkLaunchOptions } from "./fork-settings.ts";
import { stopProcessTree } from "./process.ts";

type RpcResponse = {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

type RpcEvent = JsonAgentSessionEvent | {
	type: "extension_ui_request";
	id: string;
	method: string;
};

type PendingRequest = {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 64 * 1024;

export type ChildExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
};

export type ChildEventListener = (event: RpcEvent) => void;
export type ChildExitListener = (exit: ChildExit) => void;

export function piInvocation(args: string[]): { command: string; args: string[] } {
	const packageDir = getPackageDir();
	const bundledCli = join(packageDir, "dist", "bundle", "cli.js");
	if (existsSync(bundledCli)) return { command: process.execPath, args: [bundledCli, ...args] };
	const cli = join(packageDir, "dist", "cli.js");
	if (existsSync(cli)) return { command: process.execPath, args: [cli, ...args] };

	const executable = basename(process.execPath).toLowerCase();
	if (executable === "node" || executable === "node.exe" || executable === "bun" || executable === "bun.exe") {
		return { command: "pi", args };
	}
	return { command: process.execPath, args };
}

export class RpcChild {
	private process: ChildProcess | undefined;
	private pid?: number;
	private exited = false;
	private exitStatus?: ChildExit;
	private stopPromise?: Promise<void>;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<ChildEventListener>();
	private readonly exitListeners = new Set<ChildExitListener>();
	private requestNumber = 0;
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private stderr = Buffer.alloc(0);

	constructor(
		private readonly cwd: string,
		private readonly sessionFile: string,
		private readonly options: ForkLaunchOptions = {},
	) {}

	isAlive(): boolean {
		return this.process !== undefined && !this.exited && !this.exitStatus && this.process.exitCode === null;
	}

	getPid(): number {
		return this.pid!;
	}

	getStderr(): string {
		return this.stderr.toString("utf8");
	}

	onEvent(listener: ChildEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: ChildExitListener): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.process) throw new Error("Child process already started");
		const separator = this.options.model?.indexOf("/") ?? -1;
		if (this.options.model && (separator < 1 || separator === this.options.model.length - 1)) {
			throw new Error("Fork model must be an exact provider/model-id");
		}

		const args = ["--mode", "rpc", "--session", this.sessionFile];
		const invocation = piInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			env: {
				...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("PI_CHILD_"))),
				PI_FORK_CHILD: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		this.process = child;
		this.exited = false;

		child.stdout?.on("data", (chunk: Buffer | string) => this.consumeStdout(chunk));
		child.stdout?.once("end", () => this.flushStdout());
		child.stderr?.on("data", (chunk: Buffer | string) => this.appendStderr(chunk));
		child.on("error", (error) => this.rejectPending(error));
		child.stdin?.on("error", (error) => this.rejectPending(new Error(`Fork stdin error: ${error.message}`)));
		child.once("exit", (code, signal) => this.handleExit({ code, signal }));

		const result = await new Promise<{ error?: Error }>((resolve) => {
			const onSpawn = () => {
				child.off("error", onError);
				this.pid = child.pid!;
				resolve({});
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				resolve({ error });
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});

		if (result.error) {
			this.process = undefined;
			throw new Error(`Could not start fork: ${result.error.message}`);
		}

		if (this.options.model) {
			await this.request({
				type: "set_model",
				provider: this.options.model.slice(0, separator),
				modelId: this.options.model.slice(separator + 1),
			});
		}
		if (this.options.thinkingLevel) {
			await this.request({ type: "set_thinking_level", level: this.options.thinkingLevel });
		}
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		const child = this.process;
		const pid = this.pid ?? child?.pid;
		if (!child && pid === undefined) return Promise.resolve();

		this.stopPromise = (async () => {
			await stopProcessTree(child, pid);
			if (this.process === child && this.isAlive()) this.handleExit({ code: null, signal: "SIGKILL" });
		})();
		return this.stopPromise;
	}

	async prompt(message: string): Promise<void> {
		await this.request({ type: "prompt", message });
	}

	async steer(message: string): Promise<void> {
		await this.request({ type: "steer", message });
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	private async request(command: Record<string, unknown>): Promise<unknown> {
		const child = this.process;
		if (!child || child.exitCode !== null || !child.stdin) throw new Error("Fork process is not running");

		const id = `pi-tiny-fork-${++this.requestNumber}`;
		let request!: PendingRequest;
		const pending = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pending.get(id) !== request) return;
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for RPC response to ${String(command.type)}`));
			}, REQUEST_TIMEOUT_MS);
			request = { resolve, reject, timeout };
			this.pending.set(id, request);
		});

		try {
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		} catch (error) {
			if (this.pending.delete(id)) clearTimeout(request.timeout);
			throw error;
		}

		return pending;
	}

	private appendStderr(chunk: Buffer | string): void {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const stderr = Buffer.concat([this.stderr, bytes]);
		this.stderr = stderr.length <= MAX_STDERR_BYTES ? stderr : stderr.subarray(-MAX_STDERR_BYTES);
	}

	private consumeStdout(chunk: Buffer | string): void {
		if (!this.process || this.exited) return;
		this.buffer += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.processLine(line);
		}
	}

	private processLine(line: string): void {
		if (!this.process || this.exited || !line.trim()) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const record = value as Record<string, unknown>;
		if (typeof record.type !== "string") return;

		if (record.type === "response") {
			const id = typeof record.id === "string" ? record.id : undefined;
			if (!id) return;
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timeout);
			const response = record as unknown as RpcResponse;
			if (response.success) pending.resolve(response.data);
			else pending.reject(new Error(response.error ?? `RPC command failed: ${response.command}`));
			return;
		}

		const event = record as unknown as RpcEvent;
		if (event.type === "extension_ui_request") {
			this.cancelDialog(event);
		}
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// Event consumers must not break the protocol reader.
			}
		}
	}

	private cancelDialog(event: Extract<RpcEvent, { type: "extension_ui_request" }>): void {
		if (!this.process?.stdin || !["select", "confirm", "input", "editor"].includes(event.method)) return;
		try {
			this.process.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
		} catch {
			return;
		}
	}

	private flushStdout(): void {
		this.buffer += this.decoder.end();
		if (this.buffer.trim()) this.processLine(this.buffer);
	}

	private handleExit(exit: ChildExit): void {
		if (this.process === undefined || this.exited || this.exitStatus) return;
		this.exitStatus = exit;
		// Drain queued stdio without waiting for inherited pipes to close.
		setImmediate(() => {
			this.exitStatus = undefined;
			this.exited = true;
			const error = new Error(
				`Fork process exited${exit.code === null ? ` with ${exit.signal ?? "no status"}` : ` with code ${exit.code}`}`,
			);
			this.rejectPending(error);
			for (const listener of this.exitListeners) listener(exit);
		});
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
