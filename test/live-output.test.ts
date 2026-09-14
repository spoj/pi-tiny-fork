import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveOutput, type LiveChunk } from "../src/live-output.ts";

const BATCH_MS = 2_000;

function output() {
	const chunks: LiveChunk[] = [];
	const live = new LiveOutput((chunk) => chunks.push(chunk));
	return { live, chunks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LiveOutput", () => {
	it("uses a fixed timer and emits only new sanitized text", () => {
		const { live, chunks } = output();

		live.append(Buffer.from("first"));
		vi.advanceTimersByTime(1_999);
		live.append(Buffer.from("\r line"));
		expect(chunks).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(chunks).toEqual([{ text: "first line", startsWithContinuation: false, endsWithPartialLine: true }]);

		live.append(Buffer.from("\nsecond"));
		vi.advanceTimersByTime(BATCH_MS);
		expect(chunks[1]).toEqual({ text: "\nsecond", startsWithContinuation: true, endsWithPartialLine: true });

		live.append(Buffer.from("\n"));
		vi.advanceTimersByTime(BATCH_MS);
		expect(chunks[2]).toEqual({ text: "\n", startsWithContinuation: true, endsWithPartialLine: false });
	});

	it("does not emit for silence and returns an empty final status chunk", () => {
		const { live, chunks } = output();

		live.append(Buffer.from("\x1b[31m"));
		vi.advanceTimersByTime(BATCH_MS);
		expect(chunks).toEqual([]);
		expect(live.finish()).toEqual({ text: "", startsWithContinuation: false, endsWithPartialLine: false });
		expect(live.finish()).toBeUndefined();
	});

	it("returns pending text on finish without emitting it", () => {
		const { live, chunks } = output();

		live.append(Buffer.from("partial"));
		expect(live.finish()).toEqual({ text: "partial", startsWithContinuation: false, endsWithPartialLine: true });
		expect(chunks).toEqual([]);
		vi.advanceTimersByTime(BATCH_MS);
		expect(chunks).toEqual([]);
		expect(live.finish()).toBeUndefined();
	});

	it("returns current continuation flags when the final buffer is empty", () => {
		const { live, chunks } = output();

		live.append(Buffer.from("partial"));
		vi.advanceTimersByTime(BATCH_MS);
		expect(chunks[0]).toEqual({ text: "partial", startsWithContinuation: false, endsWithPartialLine: true });
		expect(live.finish()).toEqual({ text: "", startsWithContinuation: true, endsWithPartialLine: true });
	});

	it("handles split UTF-8 and terminal controls without leaking payloads", () => {
		const { live } = output();
		const word = Buffer.from("終");

		live.append(word.subarray(0, 2));
		live.append(Buffer.concat([
			word.subarray(2),
			Buffer.from(" ok\x1b[31"),
		]));
		live.append(Buffer.from("mred\x1b]title\nnot visible\x07shown\n"));

		expect(live.finish()).toEqual({
			text: "終 okredshown\n",
			startsWithContinuation: false,
			endsWithPartialLine: false,
		});
	});

	it("sanitizes split C1 controls and drops incomplete controls at EOF", () => {
		const { live } = output();
		const csi = Buffer.from("\u009b31m");
		const osc = Buffer.from("\u009dtitle\n\u009c");

		live.append(Buffer.from("before\x1b"));
		live.append(Buffer.from("]title\nignored"));
		live.append(Buffer.from("\x07"));
		live.append(csi.subarray(0, 1));
		live.append(Buffer.concat([csi.subarray(1), osc.subarray(0, 1)]));
		live.append(osc.subarray(1));
		live.append(Buffer.from("after\x1b[123"));

		expect(live.finish()).toEqual({
			text: "beforeafter",
			startsWithContinuation: false,
			endsWithPartialLine: true,
		});
	});

	it("suppresses output after a raw-byte batch limit", () => {
		const { live, chunks } = output();

		live.append(Buffer.alloc(50 * 1024, 0x61));
		live.append(Buffer.from("b"));
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ suppressed: true, text: expect.stringContaining("suppressed") });
		live.append(Buffer.from("later"));
		vi.advanceTimersByTime(BATCH_MS * 2);
		expect(chunks).toHaveLength(1);
	});

	it("bounds decoded output that expands beyond the byte batch limit", () => {
		const { live, chunks } = output();

		live.append(Buffer.alloc(50 * 1024, 0xff));
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ suppressed: true });
		expect(live.finish()).toBeUndefined();
	});

	it("reports decoder expansion at EOF without emitting during finish", () => {
		const { live, chunks } = output();
		live.append(Buffer.concat([Buffer.alloc(50 * 1024 - 1, 0x61), Buffer.from([0xc2])]));
		expect(live.finish()).toMatchObject({ suppressed: true });
		expect(chunks).toEqual([]);
		expect(live.finish()).toBeUndefined();
	});

	it("limits visible newlines on a rolling window", () => {
		const { live, chunks } = output();

		live.append(Buffer.from("x\n".repeat(500)));
		vi.advanceTimersByTime(BATCH_MS);
		expect(chunks[0]).toMatchObject({ text: "x\n".repeat(500) });
		expect(chunks[0]).not.toHaveProperty("suppressed");

		live.append(Buffer.from("\n"));
		expect(chunks).toHaveLength(2);
		expect(chunks[1]).toMatchObject({ suppressed: true });
	});

	it("ends an OSC on BEL after a split ESC", () => {
		const { live } = output();

		live.append(Buffer.from("before\x1b]title\x1b"));
		live.append(Buffer.from("\x07visible"));

		expect(live.finish()).toEqual({ text: "beforevisible", startsWithContinuation: false, endsWithPartialLine: true });
	});

	it("does not count newlines inside terminal strings", () => {
		const { live } = output();

		live.append(Buffer.from("\x1b]title\n".repeat(501) + "visible\x07done"));
		expect(live.finish()).toEqual({ text: "done", startsWithContinuation: false, endsWithPartialLine: true });
	});

	it("lets a C1 OSC interrupt an incomplete CSI", () => {
		const { live } = output();

		live.append(Buffer.from("before\x1b[12\u009dhidden\n\u0007after"));
		expect(live.finish()).toEqual({ text: "beforeafter", startsWithContinuation: false, endsWithPartialLine: true });
	});

	it("does not limit a partial line across timed chunks", () => {
		const { live, chunks } = output();

		live.append(Buffer.alloc(32 * 1024, 0x61));
		vi.advanceTimersByTime(BATCH_MS);
		live.append(Buffer.alloc(32 * 1024, 0x62));
		vi.advanceTimersByTime(BATCH_MS);
		live.append(Buffer.from("c"));
		vi.advanceTimersByTime(BATCH_MS);

		expect(chunks).toHaveLength(3);
		expect(chunks.every((chunk) => !chunk.suppressed)).toBe(true);
		expect(chunks[2].endsWithPartialLine).toBe(true);
	});

	it("disposes pending output and callbacks", () => {
		const { live, chunks } = output();

		live.append(Buffer.from("pending"));
		live.dispose();
		live.append(Buffer.from("late"));
		vi.advanceTimersByTime(BATCH_MS * 2);
		expect(chunks).toEqual([]);
		expect(live.finish()).toBeUndefined();
	});
});
