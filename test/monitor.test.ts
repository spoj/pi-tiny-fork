import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForkManager, type JobSnapshot, type RunSnapshot } from "../src/manager.ts";

type CapturedOutput = {
	run: RunSnapshot;
	chunk: {
		text: string;
		startsWithContinuation: boolean;
		endsWithPartialLine: boolean;
		suppressed?: boolean;
		streamEnded?: boolean;
	};
};

type Harness = {
	directory: string;
	manager: ForkManager;
	outputs: CapturedOutput[];
	settled: JobSnapshot[];
};

const harnesses: Harness[] = [];

function createHarness(): Harness {
	const directory = mkdtempSync(join(tmpdir(), "pi-tiny-monitor-run-"));
	const outputs: CapturedOutput[] = [];
	const settled: JobSnapshot[] = [];
	const manager = new ForkManager({
		cwd: directory,
		sessionDir: join(directory, "sessions"),
		onUpdate: () => undefined,
		onSettled: (job) => settled.push(job),
		onOutput: (run, chunk) => outputs.push({ run, chunk }),
	});
	const harness = { directory, manager, outputs, settled };
	harnesses.push(harness);
	return harness;
}

function node(source: string): string[] {
	return [process.execPath, "-e", source];
}

function outputsFor(outputs: CapturedOutput[], id: string): CapturedOutput[] {
	return outputs.filter(({ run }) => run.id === id);
}

async function finish(manager: ForkManager, id: string): Promise<RunSnapshot> {
	return await manager.result(id, true) as RunSnapshot;
}

async function waitFor(condition: () => boolean, timeout = 5_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function expectNoFile(path: string, duration = 2_200): Promise<void> {
	const deadline = Date.now() + duration;
	while (Date.now() < deadline) {
		expect(existsSync(path)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	expect(existsSync(path)).toBe(false);
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.manager.shutdown();
		rmSync(harness.directory, { recursive: true, force: true });
	}
});

describe("live run delivery", () => {
	it("defaults to aggregate and keeps exact stdout and stderr logs", async () => {
		const { manager, outputs, settled } = createHarness();
		const stdout = `stdout-start\n${"s".repeat(60 * 1024)}stdout-tail`;
		const stderr = `stderr-start\n${"e".repeat(60 * 1024)}stderr-tail`;
		const source = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`;

		const started = await manager.run(node(source));
		expect(started).toMatchObject({ kind: "run", delivery: "aggregate", status: "running" });
		const result = await finish(manager, started.id);

		expect(result).toMatchObject({ kind: "run", delivery: "aggregate", status: "completed", exitCode: 0, outputTruncated: true });
		expect(readFileSync(result.stdoutPath)).toEqual(Buffer.from(stdout));
		expect(readFileSync(result.stderrPath)).toEqual(Buffer.from(stderr));
		expect(result.lastOutput).toContain("stdout-tail");
		expect(outputs).toEqual([]);
		expect(settled).toHaveLength(1);
	});

	it("delivers stdout only and includes the natural exit status", async () => {
		const { manager, outputs, settled } = createHarness();
		const started = await manager.run(node([
			"process.stdout.write('stdout\\n');",
			"process.stderr.write('stderr\\n');",
		].join(" ")), { delivery: "live" });
		const result = await finish(manager, started.id);
		const chunks = outputsFor(outputs, started.id);

		expect(result).toMatchObject({ kind: "run", delivery: "live", status: "completed", exitCode: 0 });
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.map(({ chunk }) => chunk.text).join("")).toContain("stdout\n");
		expect(chunks.map(({ chunk }) => chunk.text).join("")).not.toContain("stderr");
		expect(chunks.some(({ chunk }) => chunk.streamEnded === true)).toBe(true);
		expect(settled).toEqual([]);
	});

	it("wakes a silent natural exit with a final status chunk", async () => {
		const { manager, outputs, settled } = createHarness();
		const started = await manager.run(node("process.exit(0);"), { delivery: "live" });
		const result = await finish(manager, started.id);
		const chunks = outputsFor(outputs, started.id);

		expect(result).toMatchObject({ kind: "run", delivery: "live", status: "completed", exitCode: 0 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].chunk).toMatchObject({
			text: "",
			startsWithContinuation: false,
			endsWithPartialLine: false,
			streamEnded: true,
		});
		expect(chunks[0].run).toMatchObject({ id: started.id, status: "completed", delivery: "live", exitCode: 0 });
		expect(settled).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("reports a signal in the final live status", async () => {
		const { manager, outputs, settled } = createHarness();
		const started = await manager.run(node("process.kill(process.pid, 'SIGTERM');"), { delivery: "live" });
		const result = await finish(manager, started.id);
		const chunks = outputsFor(outputs, started.id);

		expect(result).toMatchObject({ kind: "run", delivery: "live", status: "failed", signal: "SIGTERM" });
		expect(result.exitCode).toBeUndefined();
		expect(chunks).toHaveLength(1);
		expect(chunks[0].run).toMatchObject({ status: "failed", signal: "SIGTERM" });
		expect(chunks[0].chunk.streamEnded).toBe(true);
		expect(settled).toEqual([]);
	});

	it("keeps partial UTF-8 text and continuation flags across timed chunks", async () => {
		const { manager, outputs, settled } = createHarness();
		const source = [
			"const first = Buffer.from('α\\nβ');",
			"process.stdout.write(first.subarray(0, 1));",
			"setTimeout(() => process.stdout.write(first.subarray(1)), 20);",
			"setTimeout(() => process.stdout.write('γ'), 1000);",
			"setTimeout(() => process.stdout.write('終\\n'), 2300);",
			"setTimeout(() => {}, 50);",
		].join(" ");
		const started = await manager.run(node(source), { delivery: "live" });

		await waitFor(() => outputsFor(outputs, started.id).some(({ chunk }) => chunk.streamEnded === true), 6_000);
		const result = await finish(manager, started.id);
		const chunks = outputsFor(outputs, started.id);

		expect(result).toMatchObject({ delivery: "live", status: "completed", exitCode: 0 });
		expect(chunks).toHaveLength(2);
		expect(chunks[0].chunk).toMatchObject({
			text: "α\nβγ",
			startsWithContinuation: false,
			endsWithPartialLine: true,
		});
		expect(chunks[0].chunk.streamEnded).not.toBe(true);
		expect(chunks[1].chunk).toMatchObject({
			text: "終\n",
			startsWithContinuation: true,
			endsWithPartialLine: false,
			streamEnded: true,
		});
		expect(chunks[1].run).toMatchObject({ status: "completed", exitCode: 0 });
		expect(chunks.map(({ chunk }) => chunk.text).join("")).toBe("α\nβγ終\n");
		expect(settled).toEqual([]);
	}, 10_000);

	it("does not cap one logical line across live batches", async () => {
		const { manager, outputs, settled } = createHarness();
		const first = "a".repeat(32 * 1024);
		const second = `${"b".repeat(32 * 1024 + 1)}\n`;
		const source = `process.stdout.write(${JSON.stringify(first)}); setTimeout(() => process.stdout.write(${JSON.stringify(second)}), 2500);`;
		const started = await manager.run(node(source), { delivery: "live" });
		const result = await finish(manager, started.id);
		const chunks = outputsFor(outputs, started.id);

		expect(result).toMatchObject({ delivery: "live", status: "completed", exitCode: 0 });
		expect(readFileSync(result.stdoutPath, "utf8")).toBe(first + second);
		expect(chunks.some(({ chunk }) => chunk.suppressed === true)).toBe(false);
		expect(chunks.map(({ chunk }) => chunk.text).join("")).toBe(first + second);
		expect(settled).toEqual([]);
	}, 15_000);

	it("flushes pending output on stop without an exit wake", async () => {
		const { directory, manager, outputs, settled } = createHarness();
		const ready = join(directory, "pending-ready");
		const source = [
			"const fs = require('node:fs');",
			`process.stdout.write('pending', () => fs.writeFileSync(${JSON.stringify(ready)}, 'ready'));`,
			"setInterval(() => {}, 1000);",
		].join(" ");
		const started = await manager.run(node(source), { delivery: "live" });
		await waitFor(() => existsSync(ready));
		await new Promise((resolve) => setImmediate(resolve));

		const stopped = await manager.stop(started.id) as RunSnapshot;
		const chunks = outputsFor(outputs, started.id);
		expect(stopped).toMatchObject({ kind: "run", delivery: "live", status: "stopped" });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].chunk).toMatchObject({
			text: "pending",
			startsWithContinuation: false,
			endsWithPartialLine: true,
		});
		expect(chunks[0].chunk.streamEnded).not.toBe(true);
		expect(settled).toEqual([]);
	});

	it("stays silent while shutting down live runs", async () => {
		const { directory, manager, outputs, settled } = createHarness();
		const ready = join(directory, "shutdown-ready");
		const source = [
			"const fs = require('node:fs');",
			`process.stdout.write('pending', () => fs.writeFileSync(${JSON.stringify(ready)}, 'ready'));`,
			"setInterval(() => {}, 1000);",
		].join(" ");
		const started = await manager.run(node(source), { delivery: "live" });
		await waitFor(() => existsSync(ready));
		await new Promise((resolve) => setImmediate(resolve));

		await manager.shutdown();
		expect(manager.status(started.id)).toMatchObject({ status: "stopped", delivery: "live" });
		expect(outputs).toEqual([]);
		expect(settled).toEqual([]);
	});

	it.each([
		{
			name: "a raw batch over 50 KiB",
			noise: "RAW-NOISE".repeat(6_000),
		},
		{
			name: "more than 500 newlines in ten seconds",
			noise: "LINE-NOISE\n".repeat(501),
		},
	])("suppresses $name without killing the command", async ({ noise }) => {
		const { directory, manager, outputs, settled } = createHarness();
		const ready = join(directory, "noise-ready");
		const finished = join(directory, "noise-finished");
		const source = [
			"const fs = require('node:fs');",
			`const noise = ${JSON.stringify(noise)};`,
			`process.stdout.write(noise, () => { fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => { process.stderr.write('stderr-after\\n'); process.stdout.write('after-noise\\n', () => fs.writeFileSync(${JSON.stringify(finished)}, 'finished')); }, 2000); });`,
		].join(" ");
		const started = await manager.run(node(source), { delivery: "live" });

		await waitFor(() => existsSync(ready));
		await waitFor(() => outputsFor(outputs, started.id).some(({ chunk }) => chunk.suppressed === true), 6_000);
		expect(manager.status(started.id)).toMatchObject({ status: "running", delivery: "live" });
		const result = await finish(manager, started.id);
		const chunks = outputsFor(outputs, started.id);

		expect(result).toMatchObject({ kind: "run", delivery: "live", status: "completed", exitCode: 0 });
		expect(existsSync(finished)).toBe(true);
		expect(readFileSync(result.stdoutPath, "utf8")).toBe(`${noise}after-noise\n`);
		expect(readFileSync(result.stderrPath, "utf8")).toBe("stderr-after\n");
		expect(chunks.some(({ chunk }) => chunk.suppressed === true)).toBe(true);
		expect(chunks.map(({ chunk }) => chunk.text).join("")).not.toContain("RAW-NOISE");
		expect(chunks.map(({ chunk }) => chunk.text).join("")).not.toContain("LINE-NOISE");
		expect(settled).toEqual([]);
	}, 15_000);

	it("allows eight active live runs and rejects the ninth", async () => {
		const { manager } = createHarness();
		const argv = node("setInterval(() => {}, 1000);");
		const runs = await Promise.all(Array.from({ length: 8 }, () => manager.run(argv, { delivery: "live" })));

		expect(runs).toHaveLength(8);
		expect(manager.list().filter((job) => job.kind === "run" && job.delivery === "live" && (job.status === "starting" || job.status === "running"))).toHaveLength(8);
		await expect(manager.run(argv, { delivery: "live" })).rejects.toThrow(/8/);
	});

	it.skipIf(process.platform === "win32")("kills descendants during live-run shutdown", async () => {
		const { directory, manager } = createHarness();
		const childReady = join(directory, "descendant-ready");
		const leaked = join(directory, "descendant-leaked");
		const child = [
			"const fs = require('node:fs');",
			`fs.writeFileSync(${JSON.stringify(childReady)}, 'ready');`,
			"process.on('SIGTERM', () => {});",
			`setTimeout(() => fs.writeFileSync(${JSON.stringify(leaked)}, 'leaked'), 1500);`,
		].join(" ");
		const source = [
			"const { spawn } = require('node:child_process');",
			`spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' }).unref();`,
			"setInterval(() => {}, 1000);",
		].join(" ");
		await manager.run(node(source), { delivery: "live" });
		await waitFor(() => existsSync(childReady));

		await manager.shutdown();
		await expectNoFile(leaked);
	}, 10_000);

	it("passes stdin to an aggregate run and closes the stream", async () => {
		const { manager, outputs } = createHarness();
		const input = "stdin α終\n";
		const source = [
			"process.stdin.setEncoding('utf8');",
			"let input = '';",
			"process.stdin.on('data', chunk => input += chunk);",
			"process.stdin.on('end', () => process.stdout.write(input));",
		].join(" ");
		const started = await manager.run(node(source), { stdin: input });
		const result = await finish(manager, started.id);

		expect(result).toMatchObject({ kind: "run", delivery: "aggregate", status: "completed", exitCode: 0 });
		expect(readFileSync(result.stdoutPath, "utf8")).toBe(input);
		expect(outputs).toEqual([]);
	});
});
