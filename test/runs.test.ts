import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForkSnapshot, JobSnapshot, RunSnapshot } from "../src/manager.ts";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "pi-child-runs-"));
	vi.stubEnv("PI_FORK_CHILD", "");
	const packageDir = join(directory, "pi-package");
	const fakePi = join(packageDir, "dist", "bundle", "cli.js");
	mkdirSync(join(packageDir, "dist", "bundle"), { recursive: true });
	vi.stubEnv("PI_PACKAGE_DIR", packageDir);
	writeFileSync(fakePi, `
		let buffer = "";
		process.stdin.setEncoding("utf8");
		const finish = () => {
			console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "review complete" }], stopReason: "stop" } }));
			console.log(JSON.stringify({ type: "agent_settled" }));
		};
		process.stdin.on("data", chunk => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\\n")) !== -1) {
				const command = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				const respond = () => console.log(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true }));
				if (command.type === "set_model" && command.modelId === "slow") setTimeout(respond, 5000);
				else respond();
				if (command.type === "prompt" && !command.message.includes("hang")) setTimeout(finish, 200);
				if (command.type === "steer" && command.message === "finish") finish();
			}
		});
	`);
	writeFileSync(join(directory, "client.cjs"), `
		const exec = require("node:util").promisify(require("node:child_process").execFile);
		module.exports = async (...args) => {
			const { stdout } = await exec(process.env.PI_CHILD_NODE, [process.env.PI_CHILD_CLI, ...args], { maxBuffer: 1024 * 1024 });
			return JSON.parse(stdout);
		};
	`);
	const { default: extension } = await import("../src/index.ts");
	const pi = { on: vi.fn(), registerTool: vi.fn(), sendMessage: vi.fn() };
	const ctx = { cwd: directory, sessionManager: { getSessionDir: () => join(directory, "sessions") }, ui: { setWidget: vi.fn() } };
	extension(pi as never);
	const hook = (name: string) => pi.on.mock.calls.find(([type]) => type === name)![1];
	const close = async () => { await hook("session_shutdown")({}, ctx); };
	cleanups.push(async () => {
		await close();
		rmSync(directory, { recursive: true, force: true });
	});
	await hook("session_start")({}, ctx);
	const env = { ...process.env };
	const tools = Object.fromEntries(pi.registerTool.mock.calls.map(([tool]) => [tool.name, tool]));
	const call = async (args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<any> => {
		const { stdout } = await exec(env.PI_CHILD_NODE!, [env.PI_CHILD_CLI!, ...args], {
			env: { ...env, ...extraEnv }, timeout: 12_000, maxBuffer: 1024 * 1024,
		});
		return JSON.parse(stdout);
	};
	const script = (name: string, body: string) => {
		const path = join(directory, `${name}.cjs`);
		writeFileSync(path, `const call = require("./client.cjs");\n(async () => { ${body} })().catch(error => { console.error(error.message); process.exitCode = 1; });`);
		return path;
	};
	return { directory, pi, tools, call, script, close, ctx };
}

afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("script runs through the shared extension and CLI", () => {
	it("collects concurrent children from descendant scripts and notifies only once", async () => {
		const { directory, pi, tools, call, script } = await setup();
		mkdirSync(join(directory, "workspace"));
		const helper = script("helper", `
			const child = await call("start", "--task", "hang review tests", "--model", "test/fake", "--thinking", "off");
			console.log(JSON.stringify(child));
		`);
		const root = script("review", `
			const exec = require("node:util").promisify(require("node:child_process").execFile);
			const descendant = exec(process.env.PI_CHILD_NODE, [${JSON.stringify(helper)}]);
			const child = await call("start", "--task", "hang review auth", "--model", "test/fake", "--thinking", "off");
			const children = [child, JSON.parse((await descendant).stdout)];
			const results = Promise.all(children.map(child => call("result", child.id, "--wait")));
			await Promise.all(children.map(child => call("steer", child.id, "finish")));
			console.log(JSON.stringify(await results));
		`);
		const run: RunSnapshot = await call(["run", "--cwd", "workspace", "--", process.execPath, root]);
		expect(run.status).toBe("running");
		const standalone = await tools.Fork.execute("tool-call", { task: "hang", cwd: null, model: "test/fake", thinkingLevel: "off" });
		const standaloneId = standalone.details.id;
		expect((await call(["status", standaloneId])).status).toBe("running");
		const result: RunSnapshot = await call(["result", run.id, "--wait"]);
		expect(result.status).toBe("completed");
		expect(result.childIds).toHaveLength(2);
		const children: ForkSnapshot[] = JSON.parse(result.lastOutput!);
		for (const child of children) {
			expect(child).toMatchObject({ kind: "child", runId: run.id, cwd: join(directory, "workspace"), status: "completed", lastOutput: "review complete" });
			expect(result.childIds).toContain(child.id);
			expect(await call(["result", child.id])).toMatchObject({ id: child.id, status: "completed" });
		}
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls[0][0].details).toMatchObject([{ id: run.id }]);
		expect((await call(["status", standaloneId])).status).toBe("running");
		await call(["steer", standaloneId, "finish"]);
		expect((await call(["result", standaloneId, "--wait"])).status).toBe("completed");
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls[0][0].details).toMatchObject([{ id: run.id }, { id: standaloneId }]);
	}, 20_000);

	it("cancels a run and its waiting children without touching unrelated work or accepting late starts", async () => {
		const { pi, tools, call, script } = await setup();
		const root = script("waiting", `
			const children = await Promise.all(["hang one", "hang two"].map(task => call("start", "--task", task, "--model", "test/fake", "--thinking", "off")));
			console.log(JSON.stringify(children.map(child => child.id)));
			await Promise.all(children.map(child => call("result", child.id, "--wait")));
		`);
		const standalone = await tools.Fork.execute("tool-call", { task: "hang standalone", cwd: null, model: "test/fake", thinkingLevel: "off" });
		const run: RunSnapshot = await call(["run", "--", process.execPath, root]);
		let children: ForkSnapshot[] = [];
		await expect.poll(async () => {
			children = (await call(["status"]) as JobSnapshot[]).filter((job): job is ForkSnapshot => job.kind === "child" && job.runId === run.id && job.status === "running");
			return children.length;
		}, { timeout: 10_000 }).toBe(2);
		const waiting = call(["result", run.id, "--wait"]);
		const stopped: RunSnapshot = await call(["stop", run.id]);
		expect(stopped.status).toBe("stopped");
		expect((await waiting).status).toBe("stopped");
		for (const child of children) {
			expect((await call(["result", child.id])).status).toBe("stopped");
			await expect.poll(() => { try { process.kill(child.pid!, 0); return true; } catch { return false; } }).toBe(false);
		}
		expect((await call(["status", standalone.details.id])).status).toBe("running");
		await expect(call(["start", "--task", "late", "--model", "test/fake", "--thinking", "off"], { PI_CHILD_RUN_ID: run.id })).rejects.toThrow("closed");
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls[0][0].details).toMatchObject([{ id: run.id }]);
	}, 20_000);

	it("cancels children still configuring their model without letting startup revive them", async () => {
		const { call, script } = await setup();
		const root = script("slow-start", `
			await call("start", "--task", "hang", "--model", "test/slow", "--thinking", "off");
		`);
		const run = await call(["run", "--", process.execPath, root]);
		let child: JobSnapshot | undefined;
		await expect.poll(async () => {
			child = (await call(["status"]) as JobSnapshot[]).find((job) => job.kind === "child" && job.runId === run.id);
			return child?.status;
		}, { timeout: 10_000 }).toBe("starting");
		expect((await call(["stop", run.id])).status).toBe("stopped");
		expect((await call(["result", child!.id])).status).toBe("stopped");
	}, 15_000);

	it("cleans up unfinished children even when a script exits successfully without waiting", async () => {
		const { call, script } = await setup();
		const root = script("early-exit", `
			const child = await call("start", "--task", "hang", "--model", "test/fake", "--thinking", "off");
			console.log(child.id);
		`);
		const run = await call(["run", "--", process.execPath, root]);
		const result = await call(["result", run.id, "--wait"]);
		expect(result.status).toBe("completed");
		expect((await call(["result", result.childIds[0]])).status).toBe("stopped");
	}, 15_000);

	it("keeps live script children in the same run and cleans them on script exit", async () => {
		const { call, script } = await setup();
		const root = script("live-ownership", `
			const child = await call("start", "--task", "hang live child", "--model", "test/fake", "--thinking", "off");
			console.log(JSON.stringify(child));
		`);
		const run: RunSnapshot = await call(["run", "--stream", "--", process.execPath, root]);
		expect(run).toMatchObject({ kind: "run", delivery: "live", status: "running" });

		const result: RunSnapshot = await call(["result", run.id, "--wait"]);
		expect(result).toMatchObject({ kind: "run", delivery: "live", status: "completed", childIds: [expect.any(String)] });
		const child: ForkSnapshot = JSON.parse(result.lastOutput!);
		expect(child).toMatchObject({ kind: "child", runId: run.id, status: "running" });
		expect(result.childIds).toEqual([child.id]);
		expect((await call(["result", child.id])).status).toBe("stopped");
	}, 15_000);

	it("rejects nested runs and retains bounded output with full logs", async () => {
		const { call, script } = await setup();
		const root = script("nested", `
			try {
				await call("run", "--", process.env.PI_CHILD_NODE, "-e", "process.exit(0)");
				throw new Error("unexpected nested run");
			} catch (error) {
				if (!error.message.includes("Nested runs")) throw error;
			}
			process.stdout.write("終".repeat(20_000) + "done");
		`);
		const run = await call(["run", "--", process.execPath, root]);
		const result = await call(["result", run.id, "--wait"]);
		expect(result).toMatchObject({ status: "completed", childIds: [], outputTruncated: true });
		expect(Buffer.byteLength(result.lastOutput)).toBeLessThanOrEqual(50 * 1024);
		expect(result.lastOutput).toMatch(/done$/);
		expect(result.lastOutput).not.toContain("�");
		expect(readFileSync(result.stdoutPath).length).toBe(60_004);
	}, 15_000);

	it.each([1999, 2000, 2001])("keeps newline-terminated preview lines at the %s-line boundary", async (lineCount) => {
		const { call } = await setup();
		const run = await call(["run", "--", process.execPath, "-e", `process.stdout.write(Array.from({length:${lineCount}}, (_, i) => \`line-\${i + 1}\`).join("\\n") + "\\n")`]);
		const result = await call(["result", run.id, "--wait"]);
		const firstLine = lineCount > 2000 ? 2 : 1;
		const expected = Array.from({ length: Math.min(lineCount, 2000) }, (_, i) => `line-${lineCount > 2000 ? lineCount - 1999 + i : i + 1}`).join("\n") + "\n";
		expect(result.lastOutput).toBe(expected);
		expect(result.outputTruncated ?? false).toBe(lineCount > 2000);
		expect(result.lastOutput.split("\n")[0]).toBe(`line-${firstLine}`);
	}, 15_000);

	it("batches script failure and failed executable startup without duplicates", async () => {
		const { directory, pi, call } = await setup();
		const run = await call(["run", "--", process.execPath, "-e", "console.log('partial'); console.error('diagnostic'); process.exit(3)"]);
		const result = await call(["result", run.id, "--wait"]);
		expect(result).toMatchObject({ status: "failed", exitCode: 3, lastOutput: "partial\n" });
		expect(result.error).toContain("diagnostic");
		await expect(call(["run", "--", join(directory, "missing-executable")])).rejects.toThrow("Could not start");
		expect((await call(["status"]) as JobSnapshot[]).every((job) => job.status === "failed")).toBe(true);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls[0][0].details).toMatchObject([{ id: run.id, status: "failed" }, { status: "failed" }]);
	}, 15_000);

	it.skipIf(process.platform === "win32")("settles waiters when a POSIX log is replaced by a directory", async () => {
		const { pi, call } = await setup();
		const run = await call(["run", "--", process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		rmSync(run.stdoutPath);
		mkdirSync(run.stdoutPath);
		writeFileSync(join(run.stdoutPath, "entry"), "not a log");
		const waiting = call(["result", run.id, "--wait"]);
		expect(await call(["stop", run.id])).toMatchObject({ status: "failed" });
		expect(await waiting).toMatchObject({ status: "failed", error: expect.stringContaining("Run cleanup failed") });
		expect(pi.sendMessage).toHaveBeenCalledOnce();
	}, 15_000);

	it("closes waiting clients and kills active work on session shutdown", async () => {
		const { pi, call, script, close } = await setup();
		const root = script("shutdown", `
			const child = await call("start", "--task", "hang", "--model", "test/fake", "--thinking", "off");
			await call("result", child.id, "--wait");
		`);
		const run = await call(["run", "--", process.execPath, root]);
		let child: ForkSnapshot | undefined;
		await expect.poll(async () => {
			child = (await call(["status"]) as JobSnapshot[]).find((job): job is ForkSnapshot => job.kind === "child" && job.runId === run.id && job.status === "running");
			return Boolean(child);
		}, { timeout: 10_000 }).toBe(true);
		const waiting = expect(call(["result", run.id, "--wait"])).rejects.toThrow();
		await close();
		await waiting;
		await expect(call(["status"])).rejects.toThrow();
		await expect.poll(() => { try { process.kill(child!.pid!, 0); return true; } catch { return false; } }).toBe(false);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	}, 20_000);
});
