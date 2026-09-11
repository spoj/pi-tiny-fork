import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export function delegatedTask(task: string): string {
	return `<delegated-task>
Complete the task below. Return a concise final report to the parent, leading with conclusions and verification. Do not start other agents.

Task:
${task}
</delegated-task>`;
}

export function createForkSession(cwd: string, sessionDir?: string, name?: string): string {
	const session = SessionManager.create(cwd, sessionDir);
	if (name) session.appendSessionInfo(name);
	const transcriptPath = resolve(session.getSessionFile()!);
	mkdirSync(dirname(transcriptPath), { recursive: true });
	writeFileSync(transcriptPath, `${[session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	return transcriptPath;
}
