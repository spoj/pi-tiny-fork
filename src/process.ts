import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const KILL_GRACE_MS = 1_000;

function processGone(pid: number | undefined, child: ChildProcess | undefined): boolean {
	if (!pid) return !child || child.exitCode !== null || child.signalCode != null;
	try {
		process.kill(-pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "EPERM";
	}
}

function terminate(pid: number | undefined, child: ChildProcess | undefined, signal: NodeJS.Signals): void {
	if (!pid) {
		child?.kill(signal);
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		child?.kill(signal);
	}
}

export async function stopProcessTree(child: ChildProcess | undefined, pid?: number): Promise<void> {
	child?.stdin?.destroy();
	child?.stdout?.destroy();
	child?.stderr?.destroy();
	const targetPid = pid ?? child?.pid;
	if (!targetPid && !child) return;

	if (process.platform === "win32") {
		if (targetPid === undefined) {
			child?.kill("SIGTERM");
			return;
		}
		await new Promise<void>((resolve) => {
			execFile(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/pid", String(targetPid), "/t", "/f"],
				{ windowsHide: true },
				(error: Error | null) => {
					if (error) child?.kill("SIGTERM");
					resolve();
				},
			);
		});
		return;
	}

	if (processGone(targetPid, child)) return;
	terminate(targetPid, child, "SIGTERM");
	const startedAt = Date.now();
	while (true) {
		if (processGone(targetPid, child)) return;
		if (Date.now() - startedAt >= KILL_GRACE_MS) {
			terminate(targetPid, child, "SIGKILL");
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}
