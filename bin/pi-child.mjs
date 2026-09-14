#!/usr/bin/env node
import { connect } from "node:net";
import { parseArgs } from "node:util";

const HELP = `Usage: pi-child <command> [options]

Commands:
  run [--cwd DIR] [--stream] -- COMMAND [ARGS...]
  start --task TEXT [--cwd DIR] [--model provider/id] [--thinking LEVEL]
  status [ID]
  result ID [--wait]
  steer ID TEXT
  stop ID

Environment: PI_CHILD_ENDPOINT, PI_CHILD_TOKEN, PI_CHILD_RUN_ID.
`;

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function fail(message) {
	throw new Error(message);
}

function needEnv(name) {
	const value = process.env[name];
	if (!value) fail(`missing ${name}`);
	return value;
}

function parsed(args, options, allowPositionals) {
	return parseArgs({ args, options, strict: true, allowPositionals });
}

function send(request) {
	const endpoint = needEnv("PI_CHILD_ENDPOINT");
	const token = needEnv("PI_CHILD_TOKEN");
	return new Promise((resolve, reject) => {
		let settled = false;
		const socket = connect(endpoint);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("error", (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		socket.on("close", () => {
			if (!settled) {
				settled = true;
				reject(new Error("connection closed"));
			}
		});
		socket.on("data", (chunk) => {
			if (settled) return;
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			settled = true;
			socket.end();
			let value;
			try {
				value = JSON.parse(buffer.slice(0, newline));
			} catch {
				reject(new Error("invalid response"));
				return;
			}
			if (!value || typeof value !== "object" || !("ok" in value)) {
				reject(new Error("invalid response"));
				return;
			}
			resolve(value);
		});
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ token, ...request })}\n`);
		});
	});
}

async function call(request) {
	const response = await send(request);
	if (!response.ok) fail(response.error || "request failed");
	process.stdout.write(`${JSON.stringify(response.data ?? null)}\n`);
}

function withRunId(request) {
	const runId = process.env.PI_CHILD_RUN_ID;
	if (runId !== undefined) request.runId = runId;
	return request;
}

async function main() {
	if (process.env.PI_FORK_CHILD === "1") fail("pi-child cannot run inside a delegated fork");

	const [sub, ...rest] = process.argv.slice(2);
	if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
		process.stdout.write(HELP);
		if (!sub) fail("missing command");
		return;
	}

	switch (sub) {
		case "run": {
			const dash = rest.indexOf("--");
			if (dash === -1) fail("run requires -- COMMAND [ARGS...]");
			const { values } = parsed(rest.slice(0, dash), { cwd: { type: "string" }, stream: { type: "boolean" } }, false);
			const argv = rest.slice(dash + 1);
			if (argv.length === 0) fail("run requires -- COMMAND [ARGS...]");
			const request = { op: "run", argv };
			if (values.cwd !== undefined) request.cwd = values.cwd;
			if (values.stream) request.delivery = "live";
			await call(withRunId(request));
			break;
		}
		case "start": {
			const { values } = parsed(
				rest,
				{
					task: { type: "string" },
					cwd: { type: "string" },
					model: { type: "string" },
					thinking: { type: "string" },
				},
				false,
			);
			if (values.task === undefined) fail("start requires --task TEXT");
			if (values.thinking !== undefined && !LEVELS.has(values.thinking)) fail(`invalid thinking level: ${values.thinking}`);
			const request = { op: "start", task: values.task };
			if (values.cwd !== undefined) request.cwd = values.cwd;
			if (values.model !== undefined) request.model = values.model;
			if (values.thinking !== undefined) request.thinkingLevel = values.thinking;
			await call(withRunId(request));
			break;
		}
		case "status": {
			const { positionals } = parsed(rest, {}, true);
			if (positionals.length > 1) fail("status takes at most one ID");
			await call(positionals.length === 1 ? { op: "status", id: positionals[0] } : { op: "status" });
			break;
		}
		case "result": {
			const { values, positionals } = parsed(rest, { wait: { type: "boolean" } }, true);
			if (positionals.length !== 1) fail("result requires ID");
			const request = { op: "result", id: positionals[0] };
			if (values.wait) request.wait = true;
			await call(request);
			break;
		}
		case "steer": {
			const [id, ...text] = rest;
			if (!id || id.startsWith("-")) fail("steer requires ID TEXT");
			if (text.length === 0) fail("steer requires ID TEXT");
			await call({ op: "steer", id, prompt: text.join(" ") });
			break;
		}
		case "stop": {
			if (rest.length !== 1 || rest[0].startsWith("-")) fail("stop requires ID");
			await call({ op: "stop", id: rest[0] });
			break;
		}
		default:
			fail(`unknown command: ${sub}`);
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
