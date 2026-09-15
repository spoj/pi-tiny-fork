import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createForkSession, delegatedTask } from "../src/fork.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fresh child sessions", () => {
	it("creates fresh, named, persisted conversations linked to their parent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tiny-fork-"));
		directories.push(cwd);
		const sessionDir = join(cwd, "sessions");
		const parent = SessionManager.open(createForkSession(cwd, sessionDir, "Parent"));
		parent.appendMessage({ role: "user", content: "Parent-only conversation", timestamp: Date.now() });
		const parentSession = parent.getSessionFile();
		const first = createForkSession(cwd, sessionDir, "Review the change", parentSession);
		const second = createForkSession(cwd, sessionDir, undefined, parentSession);
		const session = SessionManager.open(first);

		expect(first).not.toBe(second);
		expect(session.getCwd()).toBe(cwd);
		expect(session.getSessionName()).toBe("Review the change");
		expect(session.buildSessionContext().messages).toEqual([]);
		expect(session.getHeader()?.parentSession).toBe(parentSession);
		expect(SessionManager.open(second).getHeader()?.parentSession).toBe(parentSession);
		expect(SessionManager.open(second).getEntries()).toEqual([]);
		expect(parent.buildSessionContext().messages).toHaveLength(1);
		expect(JSON.parse(readFileSync(first, "utf8").split("\n")[0]).type).toBe("session");
		if (process.platform !== "win32") expect(statSync(first).mode & 0o777).toBe(0o600);
	});

	it("omits ancestry for an in-memory parent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tiny-fork-"));
		directories.push(cwd);
		const parent = SessionManager.inMemory(cwd);
		const path = createForkSession(cwd, join(cwd, "sessions"), undefined, parent.getSessionFile());
		const child = SessionManager.open(path);
		expect(child.getHeader()).not.toHaveProperty("parentSession");
		expect(child.buildSessionContext().messages).toEqual([]);
	});

	it("wraps the task with concise reporting and non-delegation guidance", () => {
		expect(delegatedTask("Review the change")).toBe(`<delegated-task>
Do not start subagents. Lead with concise conclusions and verification.

Review the change
</delegated-task>`);
	});
});
