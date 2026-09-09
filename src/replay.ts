import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type Settings = {
	replayCompatibleModels?: unknown;
};

export function modelIdentity(message: Pick<AssistantMessage, "provider" | "model">): string {
	return `${message.provider}/${message.model}`;
}

export function loadCompatibleModelFamilies(settingsPath = join(getAgentDir(), "settings.json")): Set<string>[] {
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
		if (!Array.isArray(settings.replayCompatibleModels)) return [];

		const families: Set<string>[] = [];
		for (const family of settings.replayCompatibleModels) {
			if (Array.isArray(family) && family.length > 0 && family.every((model) => typeof model === "string")) {
				families.push(new Set(family as string[]));
			}
		}
		return families;
	} catch {
		return [];
	}
}

export function canReplay(source: string, target: string, families: Set<string>[]): boolean {
	return families.some((family) => family.has(source) && family.has(target));
}

export function replayCompatibleMessages(
	messages: readonly AssistantMessage[],
	target: Pick<Model<any>, "provider" | "api" | "id">,
	families: Set<string>[],
): AssistantMessage[] {
	const targetIdentity = `${target.provider}/${target.id}`;
	return messages.map((message) => {
		const sourceIdentity = modelIdentity(message);
		if ((sourceIdentity === targetIdentity && message.api === target.api) || !canReplay(sourceIdentity, targetIdentity, families)) return message;
		return {
			...message,
			provider: target.provider,
			api: target.api,
			model: target.id,
		};
	});
}
