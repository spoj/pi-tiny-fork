import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export function delegatedTask(task: string): string {
	return `<delegated-task>
Do not start subagents. Lead with concise conclusions and verification.

${task}
</delegated-task>`;
}

export function createForkSession(cwd: string, sessionDir?: string, name?: string, parentSession?: string): string {
	const session = SessionManager.create(cwd, sessionDir, { parentSession });
	if (name) session.appendSessionInfo(name);
	const transcriptPath = resolve(session.getSessionFile()!);
	mkdirSync(dirname(transcriptPath), { recursive: true });
	writeFileSync(transcriptPath, `${[session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	return transcriptPath;
}
