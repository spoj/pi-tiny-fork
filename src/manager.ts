import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { stopProcessTree } from "./process.ts";
import { LiveOutput, type LiveChunk } from "./live-output.ts";

export type RunStatus = "starting" | "running" | "completed" | "failed" | "stopped";

export type RunSnapshot = {
	id: string;
	argv: string[];
	cwd: string;
	stdoutPath: string;
	stderrPath: string;
	pid?: number;
	status: RunStatus;
	exitCode?: number;
	signal?: NodeJS.Signals;
};

type RunRecord = RunSnapshot & {
	finishing?: Promise<void>;
	process?: ChildProcess;
	output: LiveOutput;
	outputFile?: number;
	outputTimer?: NodeJS.Timeout;
	readOutput?: () => void;
};

type ManagerOptions = {
	sessionDir: string;
	onUpdate: () => void;
	onOutput: (run: RunSnapshot, chunk: LiveChunk & { streamEnded?: boolean }) => void;
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class MonitorManager {
	private readonly runs = new Map<string, RunRecord>();
	private readonly starts = new Set<Promise<unknown>>();
	private shuttingDown = false;

	constructor(private readonly options: ManagerOptions) {}

	list(): RunSnapshot[] {
		return Array.from(this.runs.values(), (run) => this.snapshot(run));
	}

	async run(argv: string[], options: { cwd: string; stdin?: string }): Promise<RunSnapshot> {
		if (this.shuttingDown) throw new Error("Monitor manager is shutting down");
		if (this.list().filter((run) => run.status === "starting" || run.status === "running").length >= 8) {
			throw new Error("Maximum of 8 monitors already running");
		}
		const id = `run-${randomUUID()}`;
		const directory = join(this.options.sessionDir, "runs", id);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const run: RunRecord = {
			id, argv: [...argv], cwd: options.cwd,
			stdoutPath: join(directory, "stdout.log"), stderrPath: join(directory, "stderr.log"),
			status: "starting",
			output: new LiveOutput((chunk) => {
				if (chunk.suppressed) {
					clearInterval(run.outputTimer);
					run.readOutput = undefined;
				}
				if (!this.shuttingDown) this.options.onOutput(this.snapshot(run), chunk);
			}),
		};
		this.runs.set(id, run);
		this.options.onUpdate();
		const starting = this.launch(run, options.stdin);
		this.starts.add(starting);
		try {
			return await starting;
		} finally {
			this.starts.delete(starting);
		}
	}

	async stop(id: string): Promise<RunSnapshot> {
		const run = this.runs.get(id);
		if (!run) throw new Error(`Unknown monitor: ${id}`);
		if (run.finishing) throw new Error(`${id} is not running`);
		await this.finish(run, "stopped");
		return this.snapshot(run);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await Promise.all([
			...Array.from(this.runs.values(), (run) => this.finish(run, "stopped")),
			...Array.from(this.starts, (start) => start.catch(() => undefined)),
		]);
	}

	private async launch(run: RunRecord, stdin?: string): Promise<RunSnapshot> {
		const files: number[] = [];
		try {
			for (const path of [run.stdoutPath, run.stderrPath]) files.push(openSync(path, "wx", 0o600));
			const file = openSync(run.stdoutPath, "r");
			run.outputFile = file;
			let offset = 0;
			run.readOutput = () => {
				const size = fstatSync(file).size - offset;
				if (size === 0) return;
				const buffer = Buffer.alloc(Math.min(size, 50 * 1024 + 1));
				const length = readSync(file, buffer, 0, buffer.length, offset);
				offset += length;
				run.output.append(buffer.subarray(0, length));
			};
			run.outputTimer = setInterval(run.readOutput, 100);
			const child = spawn(run.argv[0], run.argv.slice(1), {
				cwd: run.cwd,
				stdio: [stdin === undefined ? "ignore" : "pipe", files[0], files[1]],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			run.process = child;
			if (stdin !== undefined) {
				child.stdin!.on("error", () => {});
				child.stdin!.end(stdin);
			}
			child.once("exit", (code, signal) => {
				if (run.finishing) return;
				run.exitCode = code ?? undefined;
				run.signal = signal ?? undefined;
				void this.finish(run, code === 0 ? "completed" : "failed");
			});
			await new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});
			if (this.shuttingDown || run.finishing) throw new Error("Monitor was stopped during startup");
			run.pid = child.pid;
			run.status = "running";
			this.options.onUpdate();
			return this.snapshot(run);
		} catch (error) {
			await this.finish(run, "failed");
			throw new Error(`Could not start ${run.id}: ${errorText(error)}`);
		} finally {
			for (const file of files) closeSync(file);
		}
	}

	private finish(run: RunRecord, status: RunStatus): Promise<void> {
		if (run.finishing) return run.finishing;
		clearInterval(run.outputTimer);
		run.finishing = Promise.resolve().then(async () => {
			let chunk: LiveChunk | undefined;
			try {
				await stopProcessTree(run.process, run.pid);
				run.readOutput?.();
				chunk = run.output.finish();
				run.status = status;
			} catch {
				run.status = "failed";
			} finally {
				run.output.dispose();
				if (run.outputFile !== undefined) closeSync(run.outputFile);
				run.outputFile = undefined;
				run.readOutput = undefined;
			}
			if (!this.shuttingDown && (run.status !== "stopped" || chunk?.text)) {
				this.options.onOutput(this.snapshot(run), {
					text: "", startsWithContinuation: false, endsWithPartialLine: false, ...chunk, streamEnded: run.status !== "stopped",
				});
			}
			this.options.onUpdate();
		});
		return run.finishing;
	}

	private snapshot(run: RunRecord): RunSnapshot {
		const { id, argv, cwd, stdoutPath, stderrPath, status, pid, exitCode, signal } = run;
		return { id, argv: [...argv], cwd, stdoutPath, stderrPath, status,
			...(pid ? { pid } : {}), ...(exitCode !== undefined ? { exitCode } : {}), ...(signal ? { signal } : {}),
		};
	}
}
