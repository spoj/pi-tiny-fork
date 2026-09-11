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
	it("creates independent, named, persisted conversations without a parent session", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tiny-fork-"));
		directories.push(cwd);
		const first = createForkSession(cwd, join(cwd, "sessions"), "Review the change");
		const second = createForkSession(cwd, join(cwd, "sessions"));
		const session = SessionManager.open(first);

		expect(first).not.toBe(second);
		expect(session.getCwd()).toBe(cwd);
		expect(session.getSessionName()).toBe("Review the change");
		expect(session.buildSessionContext().messages).toEqual([]);
		expect(session.getHeader()).not.toHaveProperty("parentSession");
		expect(SessionManager.open(second).getEntries()).toEqual([]);
		expect(JSON.parse(readFileSync(first, "utf8").split("\n")[0]).type).toBe("session");
		if (process.platform !== "win32") expect(statSync(first).mode & 0o777).toBe(0o600);
	});

	it("wraps the task with final-report and non-delegation guidance", () => {
		const prompt = delegatedTask("Review the change");
		expect(prompt).toContain("Task:\nReview the change");
		expect(prompt).toContain("final report to the parent");
		expect(prompt).toContain("Do not start other agents");
		expect(prompt).toMatch(/^<delegated-task>[\s\S]*<\/delegated-task>$/);
	});
});
