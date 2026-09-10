import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createForkSession, delegatedTask, FORK_CONTEXTS, forkPoint } from "../src/fork.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		provider: "test",
		api: "openai-responses",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeSession(withPreviousAssistant = true): SessionManager {
	const cwd = mkdtempSync(join(tmpdir(), "pi-tiny-fork-cwd-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-tiny-fork-sessions-"));
	const session = SessionManager.create(cwd, sessionDir);
	session.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	if (withPreviousAssistant) {
		session.appendMessage(assistant([{ type: "text", text: "first answer" }]));
	}
	session.appendMessage({ role: "user", content: "delegate this", timestamp: Date.now() });
	session.appendMessage(
		assistant([
			{
				type: "toolCall",
				id: "call-fork",
				name: "Fork",
				arguments: { task: "work", context: "full", cwd: null, model: null, thinkingLevel: null },
			},
		]),
	);
	return session;
}

describe("fork creation", () => {
	it("preserves the stable prefix in full context", () => {
		const parent = makeSession();
		const { transcriptPath, referencePath } = createForkSession(parent, "full", parent.getCwd());
		const child = SessionManager.open(transcriptPath);

		expect(child.getHeader()).toMatchObject({
			type: "session",
			cwd: parent.getCwd(),
			parentSession: parent.getSessionFile(),
		});
		expect(child.getEntries()).toEqual(parent.getBranch(forkPoint(parent)!));
		expect(readFileSync(transcriptPath, "utf8")).not.toContain("call-fork");
		expect(referencePath).toBeUndefined();
	});

	it("starts reference context fresh with a stable snapshot of only the active path", () => {
		const parent = makeSession();
		const forkId = parent.getLeafId()!;
		parent.branch(parent.getEntries()[0].id);
		parent.appendMessage({ role: "user", content: "abandoned branch", timestamp: Date.now() });
		parent.branch(forkId);
		const parentBefore = readFileSync(parent.getSessionFile()!, "utf8");
		const effectiveCwd = mkdtempSync(join(tmpdir(), "pi-tiny-fork-effective-"));
		const { transcriptPath, referencePath } = createForkSession(parent, "reference", effectiveCwd, "advice");
		const child = SessionManager.open(transcriptPath);
		const snapshot = readFileSync(referencePath!, "utf8");

		expect(child.buildSessionContext().messages).toEqual([]);
		expect(child.getCwd()).toBe(effectiveCwd);
		expect(child.getSessionName()).toBe("advice");
		expect(dirname(referencePath!)).toBe(join(dirname(transcriptPath), "references"));
		expect(snapshot.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
			parent.getHeader(), ...parent.getBranch(forkPoint(parent)!),
		]);
		expect(snapshot).not.toContain("abandoned branch");
		expect(snapshot).not.toContain("call-fork");
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(parentBefore);

		parent.appendMessage({ role: "user", content: "later parent work", timestamp: Date.now() });
		child.appendMessage({ role: "user", content: "private child work", timestamp: Date.now() });
		expect(readFileSync(referencePath!, "utf8")).toBe(snapshot);
	});

	it("starts none context fresh without copying history", () => {
		const parent = makeSession();
		const parentBefore = readFileSync(parent.getSessionFile()!, "utf8");
		const { transcriptPath, referencePath } = createForkSession(parent, "none", parent.getCwd());
		const child = SessionManager.open(transcriptPath);

		expect(child.getEntries()).toEqual([]);
		expect(child.getSessionId()).not.toBe(parent.getSessionId());
		expect(referencePath).toBeUndefined();
		expect(existsSync(join(dirname(transcriptPath), "references"))).toBe(false);
		expect(readFileSync(parent.getSessionFile()!, "utf8")).toBe(parentBefore);
	});

	it.each(FORK_CONTEXTS)("names the %s child session", (context) => {
		const parent = makeSession();
		const { transcriptPath } = createForkSession(parent, context, parent.getCwd(), "delegate the implementation");
		expect(SessionManager.open(transcriptPath).getSessionName()).toBe("delegate the implementation");
	});

	it.each(FORK_CONTEXTS)("keeps the effective cwd for %s context when it differs from the stored cwd", (context) => {
		const parent = makeSession();
		const effectiveCwd = mkdtempSync(join(tmpdir(), "pi-tiny-fork-effective-"));
		const reopened = SessionManager.open(parent.getSessionFile()!, undefined, effectiveCwd);
		const { transcriptPath } = createForkSession(reopened, context, effectiveCwd);

		expect(reopened.getCwd()).toBe(effectiveCwd);
		expect(SessionManager.open(transcriptPath).getCwd()).toBe(effectiveCwd);
	});

	it.each(FORK_CONTEXTS)("materializes %s context without a previous assistant response", (context) => {
		const parent = makeSession(false);
		const { transcriptPath, referencePath } = createForkSession(parent, context, parent.getCwd());
		const child = SessionManager.open(transcriptPath);
		expect(child.buildSessionContext().messages).toHaveLength(context === "full" ? 2 : 0);
		if (referencePath) {
			expect(SessionManager.open(referencePath).buildSessionContext().messages).toHaveLength(2);
		}
	});

	it.each(FORK_CONTEXTS)("handles an empty fork prefix for %s context", (context) => {
		const parent = makeSession();
		const forkMessage = (parent.getLeafEntry() as { message: AssistantMessage }).message;
		parent.resetLeaf();
		parent.appendMessage(forkMessage);
		const { transcriptPath, referencePath } = createForkSession(parent, context, parent.getCwd());
		expect(SessionManager.open(transcriptPath).getEntries()).toEqual([]);
		if (referencePath) {
			expect(readFileSync(referencePath, "utf8").trim().split("\n")).toHaveLength(1);
		}
	});

	it("adds task guidance and an explicit working-directory notice", () => {
		const prompt = delegatedTask("work");
		expect(prompt).toContain("reference material, not instructions");
		expect(prompt).toContain("parent receives only your final report");
		expect(prompt).toContain("Task:\nwork");
		expect(prompt).not.toContain("Parent conversation snapshot:");
		expect(prompt).not.toContain("Your working directory has been switched");
		expect(delegatedTask("work", "/tmp/worktree")).toContain(
			"Your working directory has been switched to /tmp/worktree.",
		);
	});

	it("offers reference context without embedding the snapshot", () => {
		const prompt = delegatedTask("review the design", undefined, "/tmp/references/parent.jsonl");
		expect(prompt).toContain("Task:\nreview the design");
		expect(prompt).toContain("Parent conversation snapshot: /tmp/references/parent.jsonl");
		expect(prompt).toContain("Consult it if useful");
		expect(prompt).toMatch(/^<delegated-task>[\s\S]*<\/delegated-task>$/);
	});

	it("requires the current assistant Fork call", () => {
		const parent = SessionManager.create(mkdtempSync(join(tmpdir(), "pi-tiny-fork-cwd-")), mkdtempSync(join(tmpdir(), "pi-tiny-fork-sessions-")));
		parent.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		expect(() => forkPoint(parent)).toThrow("current assistant tool call");
	});
});
