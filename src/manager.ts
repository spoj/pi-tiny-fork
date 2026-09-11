import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { createForkSession, delegatedTask } from "./fork.ts";
import { RpcChild, type ChildEventListener, type ChildExit } from "./rpc.ts";
import { loadForkDefaults, resolveForkOptions, type ForkLaunchOptions } from "./fork-settings.ts";
import { stopProcessTree } from "./process.ts";

export type ForkStatus = "starting" | "running" | "completed" | "failed" | "stopped";

export type ForkSnapshot = {
	kind: "child";
	id: string;
	task: string;
	cwd: string;
	runId?: string;
	transcriptPath: string;
	pid?: number;
	status: ForkStatus;
	activity?: string;
	turns: number;
	lastOutput?: string;
	error?: string;
};

export type RunSnapshot = {
	kind: "run";
	id: string;
	argv: string[];
	cwd: string;
	childIds: string[];
	stdoutPath: string;
	stderrPath: string;
	pid?: number;
	status: ForkStatus;
	exitCode?: number;
	lastOutput?: string;
	outputTruncated?: boolean;
	error?: string;
};

export type JobSnapshot = ForkSnapshot | RunSnapshot;
export type ForkStartOptions = ForkLaunchOptions & { task: string; cwd?: string; runId?: string };

type Completion = {
	settled: boolean;
	waiters: Set<() => void>;
	finishing?: Promise<void>;
};

type ForkRecord = ForkSnapshot & Completion & {
	launchOptions: ForkLaunchOptions;
	child?: RpcChild;
	lastStopReason?: string;
};

type RunRecord = RunSnapshot & Completion & { process?: ChildProcess; closed: boolean };
type JobRecord = ForkRecord | RunRecord;

type ManagerOptions = {
	cwd: string;
	sessionDir: string;
	onUpdate: () => void;
	onSettled: (job: JobSnapshot) => void;
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ForkManager {
	private readonly jobs = new Map<string, JobRecord>();
	private readonly starts = new Set<Promise<unknown>>();
	private shuttingDown = false;

	constructor(private readonly options: ManagerOptions) {}

	list(): JobSnapshot[] {
		return Array.from(this.jobs.values(), (job) => this.snapshot(job));
	}

	status(id: string): JobSnapshot {
		return this.snapshot(this.require(id));
	}

	async result(id: string, wait = false, signal?: AbortSignal): Promise<JobSnapshot> {
		const job = this.require(id);
		if (!job.settled) {
			if (!wait) {
				throw new Error(`${id} has not finished; use result --wait in a background script`);
			}
			signal?.throwIfAborted();
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					signal?.removeEventListener("abort", abort);
					job.waiters.delete(done);
					resolve();
				};
				const abort = () => {
					job.waiters.delete(done);
					reject(signal!.reason);
				};
				job.waiters.add(done);
				signal?.addEventListener("abort", abort, { once: true });
			});
		}
		return this.snapshot(job);
	}

	async start(options: ForkStartOptions): Promise<ForkSnapshot> {
		if (this.shuttingDown) throw new Error("Fork manager is shutting down");
		const run = options.runId === undefined ? undefined : this.requireRun(options.runId);
		if (run?.closed) throw new Error(`Run ${run.id} is closed`);
		const launchOptions = resolveForkOptions(options, loadForkDefaults());
		if (!launchOptions.model?.trim()) {
			throw new Error("Fork requires a model. Choose an exact provider/model-id or configure defaultForkModel.");
		}
		if (!launchOptions.thinkingLevel) {
			throw new Error("Fork requires a thinking level. Choose one or configure defaultForkThinkingLevel.");
		}
		const cwd = resolve(run?.cwd ?? this.options.cwd, options.cwd ?? ".");
		const id = `fork-${randomUUID()}`;
		const fork: ForkRecord = {
			kind: "child", id, task: options.task, cwd, runId: run?.id,
			transcriptPath: createForkSession(cwd, this.options.sessionDir, options.task),
			launchOptions, status: "starting", turns: 0, settled: false, waiters: new Set(),
		};
		this.jobs.set(id, fork);
		run?.childIds.push(id);
		this.options.onUpdate();
		const starting = this.launch(fork);
		this.starts.add(starting);
		try {
			return await starting;
		} finally {
			this.starts.delete(starting);
		}
	}

	async run(argv: string[], options: { cwd?: string; runId?: string } = {}): Promise<RunSnapshot> {
		if (this.shuttingDown) throw new Error("Fork manager is shutting down");
		if (options.runId !== undefined) throw new Error("Nested runs are not supported; execute descendant scripts normally");
		if (!argv.length) throw new Error("A run requires a command");
		const id = `run-${randomUUID()}`;
		const directory = join(this.options.sessionDir, "runs", id);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const run: RunRecord = {
			kind: "run", id, argv: [...argv], cwd: resolve(this.options.cwd, options.cwd ?? "."),
			childIds: [], stdoutPath: join(directory, "stdout.log"), stderrPath: join(directory, "stderr.log"),
			status: "starting", closed: false, settled: false, waiters: new Set(),
		};
		this.jobs.set(id, run);
		this.options.onUpdate();
		const starting = this.launchRun(run);
		this.starts.add(starting);
		try {
			return await starting;
		} finally {
			this.starts.delete(starting);
		}
	}

	async steer(id: string, prompt: string): Promise<ForkSnapshot> {
		const fork = this.requireChild(id);
		if (fork.status !== "running" || fork.finishing || !fork.child?.isAlive()) {
			throw new Error(`${id} is not running; start a new child to continue the work`);
		}
		await fork.child.steer(prompt);
		return this.snapshot(fork);
	}

	async stop(id: string): Promise<JobSnapshot> {
		const job = this.require(id);
		if (job.finishing) throw new Error(`${id} is not running`);
		if (job.kind === "run") await this.finishRun(job, "stopped");
		else await this.finishChild(job, "stopped");
		return this.snapshot(job);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await Promise.all([
			...Array.from(this.jobs.values(), (job) => job.kind === "run"
				? this.finishRun(job, "stopped") : this.finishChild(job, "stopped")),
			...Array.from(this.starts, (start) => start.catch(() => undefined)),
		]);
	}

	private async launch(fork: ForkRecord): Promise<ForkSnapshot> {
		try {
			const child = new RpcChild(fork.cwd, fork.transcriptPath, fork.launchOptions);
			fork.child = child;
			child.onEvent(this.eventListener(fork));
			child.onExit((exit) => this.handleExit(fork, child, exit));
			await child.start();
			if (this.shuttingDown || fork.finishing) throw new Error("Child was stopped during startup");
			fork.pid = child.getPid();
			fork.status = "running";
			this.options.onUpdate();
			await child.prompt(delegatedTask(fork.task));
			return this.snapshot(fork);
		} catch (error) {
			await this.finishChild(fork, "failed", errorText(error));
			throw new Error(`Could not start ${fork.id}: ${errorText(error)}`);
		}
	}

	private async launchRun(run: RunRecord): Promise<RunSnapshot> {
		const files: number[] = [];
		try {
			for (const path of [run.stdoutPath, run.stderrPath]) files.push(openSync(path, "wx", 0o600));
			const child = spawn(run.argv[0], run.argv.slice(1), {
				cwd: run.cwd,
				env: { ...process.env, PI_CHILD_RUN_ID: run.id },
				stdio: ["ignore", files[0], files[1]],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			run.process = child;
			child.once("exit", (code, signal) => {
				if (run.closed) return;
				run.exitCode = code ?? undefined;
				void this.finishRun(run, code === 0 ? "completed" : "failed", code === 0 ? undefined : `Script exited with ${code ?? signal}`);
			});
			await new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});
			if (this.shuttingDown || run.closed) throw new Error("Run was stopped during startup");
			run.pid = child.pid;
			run.status = "running";
			this.options.onUpdate();
			return this.snapshot(run);
		} catch (error) {
			await this.finishRun(run, "failed", errorText(error));
			throw new Error(`Could not start ${run.id}: ${errorText(error)}`);
		} finally {
			for (const file of files) closeSync(file);
		}
	}

	private eventListener(fork: ForkRecord): ChildEventListener {
		return (event) => {
			if (this.shuttingDown || fork.finishing) return;
			switch (event.type) {
				case "turn_start":
					fork.turns++;
					break;
				case "tool_execution_start":
					fork.activity = event.toolName;
					break;
				case "tool_execution_end":
					if (fork.activity === event.toolName) fork.activity = undefined;
					break;
				case "message_end":
					if (event.message.role === "assistant") {
						fork.lastOutput = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("") || undefined;
						fork.lastStopReason = event.message.stopReason;
						fork.error = event.message.errorMessage;
					}
					break;
				case "agent_settled":
					if (fork.lastStopReason === "error" || fork.lastStopReason === "aborted") {
						void this.finishChild(fork, "failed", fork.error ?? "Child stopped with an error");
					} else {
						void this.finishChild(fork, "completed");
					}
					break;
			}
			this.options.onUpdate();
		};
	}

	private handleExit(fork: ForkRecord, child: RpcChild, exit: ChildExit): void {
		if (fork.finishing || this.shuttingDown) return;
		void this.finishChild(fork, "failed", child.getStderr().trim() || `Process exited with ${exit.code ?? exit.signal ?? "no status"}`);
	}

	private finishChild(fork: ForkRecord, status: ForkStatus, error?: string): Promise<void> {
		if (fork.finishing) return fork.finishing;
		fork.activity = undefined;
		if (error) fork.error = error;
		fork.finishing = Promise.resolve().then(async () => {
			if (status === "stopped" && fork.child?.isAlive()) void fork.child.abort().catch(() => undefined);
			try {
				await fork.child?.stop();
				fork.status = status;
			} catch (error) {
				fork.status = "failed";
				fork.error = `Child cleanup failed: ${errorText(error)}`;
			}
			this.settle(fork);
		});
		return fork.finishing;
	}

	private finishRun(run: RunRecord, status: ForkStatus, error?: string): Promise<void> {
		if (run.finishing) return run.finishing;
		run.closed = true;
		run.error = error;
		run.finishing = Promise.resolve().then(async () => {
			try {
				const cleanup = await Promise.allSettled([
					stopProcessTree(run.process, run.pid),
					...run.childIds.map((id) => this.finishChild(this.requireChild(id), "stopped")),
				]);
				const failure = cleanup.find((result) => result.status === "rejected");
				if (failure) throw failure.reason;
				const output = [run.stdoutPath, run.stderrPath].map((path) => {
					let file: number;
					try {
						file = openSync(path, "r");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						return { text: "", truncated: false };
					}
					try {
						const size = fstatSync(file).size;
						const buffer = Buffer.alloc(Math.min(size, 50 * 1024));
						const length = readSync(file, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
						let start = 0;
						// A truncated tail can start inside a UTF-8 character.
						while (start < length && (buffer[start] & 0xc0) === 0x80) start++;
						const lines = buffer.subarray(start, length).toString("utf8").split("\n");
						return { text: lines.slice(-2000).join("\n"), truncated: size > buffer.length || lines.length > 2000 };
					} finally { closeSync(file); }
				});
				run.lastOutput = output[0].text || undefined;
				run.outputTruncated = output.some(({ truncated }) => truncated) || undefined;
				if (status === "failed" && output[1].text.trim()) run.error = `${error}\n${output[1].text.trim()}`;
				run.status = status;
			} catch (error) {
				run.status = "failed";
				run.error = `Run cleanup failed: ${errorText(error)}`;
			}
			this.settle(run);
		});
		return run.finishing;
	}

	private settle(job: JobRecord): void {
		job.settled = true;
		for (const done of job.waiters) done();
		this.options.onUpdate();
		if (!this.shuttingDown && (job.kind === "run" || !job.runId)) this.options.onSettled(this.snapshot(job));
	}

	private require(id: string): JobRecord {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown child or run: ${id}`);
		return job;
	}

	private requireChild(id: string): ForkRecord {
		const job = this.require(id);
		if (job.kind !== "child") throw new Error(`${id} is not a child`);
		return job;
	}

	private requireRun(id: string): RunRecord {
		const job = this.require(id);
		if (job.kind !== "run") throw new Error(`${id} is not a run`);
		return job;
	}

	private snapshot(job: ForkRecord): ForkSnapshot;
	private snapshot(job: RunRecord): RunSnapshot;
	private snapshot(job: JobRecord): JobSnapshot;
	private snapshot(job: JobRecord): JobSnapshot {
		if (job.kind === "child") {
			const { kind, id, task, cwd, transcriptPath, status, turns, runId, pid, activity, lastOutput, error } = job;
			return { kind, id, task, cwd, transcriptPath, status, turns,
				...(runId ? { runId } : {}), ...(pid ? { pid } : {}), ...(activity ? { activity } : {}),
				...(lastOutput ? { lastOutput } : {}), ...(error ? { error } : {}),
			};
		}
		const { kind, id, argv, cwd, childIds, stdoutPath, stderrPath, status, pid, exitCode, lastOutput, outputTruncated, error } = job;
		return { kind, id, argv: [...argv], cwd, childIds: [...childIds], stdoutPath, stderrPath, status,
			...(pid ? { pid } : {}), ...(exitCode !== undefined ? { exitCode } : {}),
			...(lastOutput ? { lastOutput } : {}), ...(outputTruncated ? { outputTruncated } : {}), ...(error ? { error } : {}),
		};
	}
}
