import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canReplay,
	loadCompatibleModelFamilies,
	modelIdentity,
	replayCompatibleMessages,
} from "../src/replay.ts";

const sol = "github-copilot/gpt-5.6-sol";
const luna = "github-copilot/gpt-5.6-luna";
const other = "github-copilot/grok-4.6";

function assistant(model: string, api = "openai-responses") {
	const slash = model.indexOf("/");
	return {
		role: "assistant" as const,
		provider: model.slice(0, slash),
		api,
		model: model.slice(slash + 1),
		content: [{ type: "text" as const, text: "hello" }],
		usage: {} as never,
		stopReason: "stop" as const,
		timestamp: 1,
	};
}

describe("compatible replay", () => {
	it("loads top-level model families from settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tiny-fork-replay-"));
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ replayCompatibleModels: [[sol, luna]] }));

		const families = loadCompatibleModelFamilies(path);
		expect(families).toHaveLength(1);
		expect(families[0].has(sol)).toBe(true);
		expect(families[0].has(luna)).toBe(true);
	});

	it("does not expose or accept malformed family values", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tiny-fork-replay-"));
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ replayCompatibleModels: [[sol, 3], "not-a-family", []] }));

		expect(loadCompatibleModelFamilies(path)).toHaveLength(0);
	});

	it("matches only models in the same family", () => {
		const families = [new Set([sol, luna])];
		expect(canReplay(sol, luna, families)).toBe(true);
		expect(canReplay(sol, other, families)).toBe(false);
	});

	it("rewrites compatible provenance within the same API", () => {
		const source = assistant(sol, "openai-responses");
		const target = { provider: "github-copilot", api: "openai-responses", id: "gpt-5.6-luna" };
		const [rewritten] = replayCompatibleMessages([source], target, [new Set([sol, luna])]);

		expect(modelIdentity(rewritten)).toBe(luna);
		expect(rewritten.api).toBe(target.api);
		expect(rewritten.content).toBe(source.content);
		expect(replayCompatibleMessages([source], { ...target, id: "grok-4.6" }, [new Set([sol, luna])])[0]).toBe(source);
	});

	it("leaves messages from another API for pi's own conversion", () => {
		const source = assistant(sol, "openai-completions");
		const target = { provider: "github-copilot", api: "openai-responses", id: "gpt-5.6-luna" };
		const [untouched] = replayCompatibleMessages([source], target, [new Set([sol, luna])]);

		expect(untouched).toBe(source);
		expect(replayCompatibleMessages([source], { ...target, id: "grok-4.6" }, [new Set([sol, luna])])[0]).toBe(source);
	});

	it("keeps foreign reasoning metadata when the API changes", () => {
		const source = {
			...assistant(sol, "openai-completions"),
			content: [{ type: "thinking" as const, thinking: "plan", thinkingSignature: "foreign-signature" }],
		};
		const target = { provider: "github-copilot", api: "openai-responses", id: "gpt-5.6-luna" };
		const [untouched] = replayCompatibleMessages([source], target, [new Set([sol, luna])]);

		expect(untouched).toBe(source);
		expect(untouched.content).toEqual([{ type: "thinking", thinking: "plan", thinkingSignature: "foreign-signature" }]);
	});

	it("leaves an API change for the same model untouched even when listed in a family", () => {
		const source = assistant(sol, "openai-completions");
		const target = { provider: "github-copilot", api: "openai-responses", id: "gpt-5.6-sol" };

		expect(replayCompatibleMessages([source], target, [new Set([sol, luna])])[0]).toBe(source);
		expect(replayCompatibleMessages([source], target, [])[0]).toBe(source);
	});

	it("leaves already matching provenance untouched", () => {
		const source = assistant(sol);
		const target = { provider: source.provider, api: source.api, id: source.model };
		expect(replayCompatibleMessages([source], target, [new Set([sol, luna])])[0]).toBe(source);
	});

	it("preserves slashes in model IDs and distinguishes providers", () => {
		const source = assistant("gateway/vendor/source-model", "openai-completions");
		const target = { provider: "another-gateway", api: "openai-completions", id: "vendor/target-model" };
		const targetIdentity = "another-gateway/vendor/target-model";
		const families = [new Set(["gateway/vendor/source-model", targetIdentity])];
		const [rewritten] = replayCompatibleMessages([source], target, families);

		expect(modelIdentity(source)).toBe("gateway/vendor/source-model");
		expect(modelIdentity(rewritten)).toBe(targetIdentity);
		expect(rewritten).toEqual({ ...source, provider: target.provider, model: target.id });
		expect(replayCompatibleMessages([source], { ...target, provider: "unlisted-gateway" }, families)[0]).toBe(source);
	});
});
