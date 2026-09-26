import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MonitorManager, type RunSnapshot } from "../src/manager.ts";

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
	manager: MonitorManager;
	outputs: CapturedOutput[];
};

const harnesses: Harness[] = [];

function createHarness(): Harness {
	const directory = mkdtempSync(join(tmpdir(), "pi-tiny-monitor-run-"));
	const outputs: CapturedOutput[] = [];
	const manager = new MonitorManager({
		sessionDir: join(directory, "sessions"),
		onUpdate: () => undefined,
		onOutput: (run, chunk) => outputs.push({ run, chunk }),
	});
	const harness = { directory, manager, outputs };
	harnesses.push(harness);
	return harness;
}

function node(source: string): string[] {
	return [process.execPath, "-e", source];
}

function start(harness: Harness, source: string, stdin?: string): Promise<RunSnapshot> {
	return harness.manager.run(node(source), { cwd: harness.directory, ...(stdin === undefined ? {} : { stdin }) });
}

function status(manager: MonitorManager, id: string): RunSnapshot {
	return manager.list().find((run) => run.id === id)!;
}

function outputsFor(outputs: CapturedOutput[], id: string): CapturedOutput[] {
	return outputs.filter(({ run }) => run.id === id);
}

async function waitFor(condition: () => boolean, timeout = 5_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function finish(harness: Harness, id: string, timeout = 5_000): Promise<RunSnapshot> {
	await waitFor(() => outputsFor(harness.outputs, id).some(({ chunk }) => chunk.streamEnded === true), timeout);
	return status(harness.manager, id);
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

describe("monitor runs", () => {
	it("keeps exact stdout and stderr logs and streams stdout only", async () => {
		const harness = createHarness();
		const stdout = `stdout-start\n${"s".repeat(20 * 1024)}stdout-tail\n`;
		const stderr = `stderr-start\n${"e".repeat(60 * 1024)}stderr-tail`;
		const started = await start(harness, `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`);
		expect(started).toMatchObject({ status: "running" });
		const result = await finish(harness, started.id);
		const chunks = outputsFor(harness.outputs, started.id);

		expect(result).toMatchObject({ status: "completed", exitCode: 0 });
		expect(readFileSync(result.stdoutPath)).toEqual(Buffer.from(stdout));
		expect(readFileSync(result.stderrPath)).toEqual(Buffer.from(stderr));
		expect(chunks.map(({ chunk }) => chunk.text).join("")).toBe(stdout);
		expect(chunks.at(-1)!.run).toMatchObject({ status: "completed", exitCode: 0 });
	});

	it("wakes a silent natural exit with a final status chunk", async () => {
		const harness = createHarness();
		const started = await start(harness, "process.exit(0);");
		await finish(harness, started.id);
		const chunks = outputsFor(harness.outputs, started.id);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].chunk).toMatchObject({
			text: "",
			startsWithContinuation: false,
			endsWithPartialLine: false,
			streamEnded: true,
		});
		expect(chunks[0].run).toMatchObject({ id: started.id, status: "completed", exitCode: 0 });
	});

	it.skipIf(process.platform === "win32")("reports a signal in the final status", async () => {
		const harness = createHarness();
		const started = await start(harness, "process.kill(process.pid, 'SIGTERM');");
		const result = await finish(harness, started.id);
		const chunks = outputsFor(harness.outputs, started.id);

		expect(result).toMatchObject({ status: "failed", signal: "SIGTERM" });
		expect(result.exitCode).toBeUndefined();
		expect(chunks).toHaveLength(1);
		expect(chunks[0].run).toMatchObject({ status: "failed", signal: "SIGTERM" });
	});

	it("keeps partial UTF-8 text and continuation flags across timed chunks", async () => {
		const harness = createHarness();
		const started = await start(harness, [
			"const first = Buffer.from('α\\nβ');",
			"process.stdout.write(first.subarray(0, 1));",
			"setTimeout(() => process.stdout.write(first.subarray(1)), 20);",
			"setTimeout(() => process.stdout.write('γ'), 1000);",
			"setTimeout(() => process.stdout.write('終\\n'), 2300);",
			"setTimeout(() => {}, 50);",
		].join(" "));
		const result = await finish(harness, started.id, 6_000);
		const chunks = outputsFor(harness.outputs, started.id);

		expect(result).toMatchObject({ status: "completed", exitCode: 0 });
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
	}, 10_000);

	it("does not cap one logical line across batches", async () => {
		const harness = createHarness();
		const first = "a".repeat(32 * 1024);
		const second = `${"b".repeat(32 * 1024 + 1)}\n`;
		const started = await start(harness, `process.stdout.write(${JSON.stringify(first)}); setTimeout(() => process.stdout.write(${JSON.stringify(second)}), 2500);`);
		const result = await finish(harness, started.id, 10_000);
		const chunks = outputsFor(harness.outputs, started.id);

		expect(readFileSync(result.stdoutPath, "utf8")).toBe(first + second);
		expect(chunks.some(({ chunk }) => chunk.suppressed === true)).toBe(false);
		expect(chunks.map(({ chunk }) => chunk.text).join("")).toBe(first + second);
	}, 15_000);

	it("flushes pending output on stop without an exit wake", async () => {
		const harness = createHarness();
		const ready = join(harness.directory, "pending-ready");
		const started = await start(harness, [
			"const fs = require('node:fs');",
			`process.stdout.write('pending', () => fs.writeFileSync(${JSON.stringify(ready)}, 'ready'));`,
			"setInterval(() => {}, 1000);",
		].join(" "));
		await waitFor(() => existsSync(ready));
		await new Promise((resolve) => setImmediate(resolve));

		const stopped = await harness.manager.stop(started.id);
		const chunks = outputsFor(harness.outputs, started.id);
		expect(stopped).toMatchObject({ status: "stopped" });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].chunk).toMatchObject({
			text: "pending",
			startsWithContinuation: false,
			endsWithPartialLine: true,
		});
		expect(chunks[0].chunk.streamEnded).not.toBe(true);
		await expect(harness.manager.stop(started.id)).rejects.toThrow("not running");
		await expect(harness.manager.stop("run-unknown")).rejects.toThrow("Unknown monitor");
	});

	it("stays silent while shutting down", async () => {
		const harness = createHarness();
		const ready = join(harness.directory, "shutdown-ready");
		const started = await start(harness, [
			"const fs = require('node:fs');",
			`process.stdout.write('pending', () => fs.writeFileSync(${JSON.stringify(ready)}, 'ready'));`,
			"setInterval(() => {}, 1000);",
		].join(" "));
		await waitFor(() => existsSync(ready));
		await new Promise((resolve) => setImmediate(resolve));

		await harness.manager.shutdown();
		expect(status(harness.manager, started.id)).toMatchObject({ status: "stopped" });
		expect(harness.outputs).toEqual([]);
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
		const harness = createHarness();
		const ready = join(harness.directory, "noise-ready");
		const finished = join(harness.directory, "noise-finished");
		const started = await start(harness, [
			"const fs = require('node:fs');",
			`const noise = ${JSON.stringify(noise)};`,
			`process.stdout.write(noise, () => { fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => { process.stderr.write('stderr-after\\n'); process.stdout.write('after-noise\\n', () => fs.writeFileSync(${JSON.stringify(finished)}, 'finished')); }, 2000); });`,
		].join(" "));

		await waitFor(() => existsSync(ready));
		await waitFor(() => outputsFor(harness.outputs, started.id).some(({ chunk }) => chunk.suppressed === true), 6_000);
		expect(status(harness.manager, started.id)).toMatchObject({ status: "running" });
		const result = await finish(harness, started.id);
		const chunks = outputsFor(harness.outputs, started.id);

		expect(result).toMatchObject({ status: "completed", exitCode: 0 });
		expect(existsSync(finished)).toBe(true);
		expect(readFileSync(result.stdoutPath, "utf8")).toBe(`${noise}after-noise\n`);
		expect(readFileSync(result.stderrPath, "utf8")).toBe("stderr-after\n");
		expect(chunks.map(({ chunk }) => chunk.text).join("")).not.toContain("RAW-NOISE");
		expect(chunks.map(({ chunk }) => chunk.text).join("")).not.toContain("LINE-NOISE");
	}, 15_000);

	it("allows eight active monitors and rejects the ninth", async () => {
		const harness = createHarness();
		const runs = await Promise.all(Array.from({ length: 8 }, () => start(harness, "setInterval(() => {}, 1000);")));

		expect(runs).toHaveLength(8);
		expect(harness.manager.list().filter((run) => run.status === "running")).toHaveLength(8);
		await expect(start(harness, "setInterval(() => {}, 1000);")).rejects.toThrow(/8/);
	});

	it.skipIf(process.platform === "win32")("kills descendants during shutdown", async () => {
		const harness = createHarness();
		const childReady = join(harness.directory, "descendant-ready");
		const leaked = join(harness.directory, "descendant-leaked");
		const child = [
			"const fs = require('node:fs');",
			`fs.writeFileSync(${JSON.stringify(childReady)}, 'ready');`,
			"process.on('SIGTERM', () => {});",
			`setTimeout(() => fs.writeFileSync(${JSON.stringify(leaked)}, 'leaked'), 1500);`,
		].join(" ");
		await start(harness, [
			"const { spawn } = require('node:child_process');",
			`spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' }).unref();`,
			"setInterval(() => {}, 1000);",
		].join(" "));
		await waitFor(() => existsSync(childReady));

		await harness.manager.shutdown();
		await expectNoFile(leaked);
	}, 10_000);

	it("passes stdin and closes the stream", async () => {
		const harness = createHarness();
		const input = "stdin α終\n";
		const started = await start(harness, [
			"process.stdin.setEncoding('utf8');",
			"let input = '';",
			"process.stdin.on('data', chunk => input += chunk);",
			"process.stdin.on('end', () => process.stdout.write(input));",
		].join(" "), input);
		const result = await finish(harness, started.id);

		expect(result).toMatchObject({ status: "completed", exitCode: 0 });
		expect(readFileSync(result.stdoutPath, "utf8")).toBe(input);
	});
});
