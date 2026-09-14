import { StringDecoder } from "node:string_decoder";

export type LiveChunk = {
	text: string;
	startsWithContinuation: boolean;
	endsWithPartialLine: boolean;
	suppressed?: boolean;
};

type SanitizerState = "text" | "escape" | "csi" | "osc" | "oscEscape";

const BATCH_MS = 2_000;
const RAW_BATCH_LIMIT = 50 * 1024;
const NEWLINE_LIMIT = 500;
const NEWLINE_WINDOW_MS = 10_000;

export class LiveOutput {
	private readonly decoder = new StringDecoder("utf8");
	private readonly emit: (chunk: LiveChunk) => void;
	private sanitizerState: SanitizerState = "text";
	private pending = "";
	private pendingStartsWithContinuation = false;
	private streamEndsWithPartialLine = false;
	private newlineTimes: number[] = [];
	private rawBatchBytes = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(emit: (chunk: LiveChunk) => void) {
		this.emit = emit;
	}

	append(chunk: Buffer): void {
		if (this.closed || chunk.length === 0) return;
		if (this.rawBatchBytes + chunk.length > RAW_BATCH_LIMIT) {
			this.suppress("Live output suppressed: output limit exceeded.");
			return;
		}

		this.rawBatchBytes += chunk.length;
		if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), BATCH_MS);
		const visible = this.sanitize(this.decoder.write(chunk));
		if (visible) this.accept(visible);
	}

	finish(): LiveChunk | undefined {
		if (this.closed) return undefined;
		this.closed = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}

		const visible = this.sanitize(this.decoder.end());
		if (Buffer.byteLength(this.pending + visible, "utf8") > RAW_BATCH_LIMIT) {
			this.dispose();
			return { text: "Live output suppressed: output limit exceeded.", startsWithContinuation: false, endsWithPartialLine: false, suppressed: true };
		}
		if (visible) this.accept(visible);
		this.sanitizerState = "text";

		const result: LiveChunk = {
			text: this.pending,
			startsWithContinuation: this.pending ? this.pendingStartsWithContinuation : this.streamEndsWithPartialLine,
			endsWithPartialLine: this.streamEndsWithPartialLine,
		};
		this.pending = "";
		this.pendingStartsWithContinuation = false;
		return result;
	}

	dispose(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = "";
		this.pendingStartsWithContinuation = false;
		this.closed = true;
	}

	private flush(): void {
		this.timer = undefined;
		this.rawBatchBytes = 0;
		if (this.closed || !this.pending) return;

		const chunk: LiveChunk = {
			text: this.pending,
			startsWithContinuation: this.pendingStartsWithContinuation,
			endsWithPartialLine: this.streamEndsWithPartialLine,
		};
		this.pending = "";
		this.pendingStartsWithContinuation = false;
		this.emit(chunk);
	}

	private accept(text: string): void {
		if (Buffer.byteLength(this.pending, "utf8") + Buffer.byteLength(text, "utf8") > RAW_BATCH_LIMIT) {
			this.suppress("Live output suppressed: output limit exceeded.");
			return;
		}
		const now = Date.now();
		this.newlineTimes = this.newlineTimes.filter((time) => now - time < NEWLINE_WINDOW_MS);
		let newlines = 0;
		for (const character of text) {
			if (character !== "\n") continue;
			if (this.newlineTimes.length + newlines >= NEWLINE_LIMIT) {
				this.suppress("Live output suppressed: output limit exceeded.");
				return;
			}
			newlines++;
		}

		const startsWithContinuation = this.streamEndsWithPartialLine;
		if (newlines) this.newlineTimes.push(...Array.from({ length: newlines }, () => now));
		this.streamEndsWithPartialLine = !text.endsWith("\n");
		if (!this.pending) this.pendingStartsWithContinuation = startsWithContinuation;
		this.pending += text;
	}

	private suppress(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = "";
		this.pendingStartsWithContinuation = false;
		this.emit({ text: reason, startsWithContinuation: false, endsWithPartialLine: false, suppressed: true });
	}

	private sanitize(text: string): string {
		let visible = "";
		for (const character of text) {
			const code = character.codePointAt(0)!;
			switch (this.sanitizerState) {
				case "text":
					if (code === 0x1b) this.sanitizerState = "escape";
					else if (code === 0x9b) this.sanitizerState = "csi";
					else if (code === 0x9d) this.sanitizerState = "osc";
					else if (code === 0x9c) continue;
					else if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))) visible += character;
					break;
				case "escape":
					if (code === 0x1b) continue;
					if (code === 0x5b || code === 0x9b) this.sanitizerState = "csi";
					else if (code === 0x5d || code === 0x9d) this.sanitizerState = "osc";
					else if (code >= 0x20 && code <= 0x2f) continue;
					else this.sanitizerState = "text";
					break;
				case "csi":
					if (code === 0x1b) this.sanitizerState = "escape";
					else if (code === 0x9b) this.sanitizerState = "csi";
					else if (code === 0x9d) this.sanitizerState = "osc";
					else if (code >= 0x40 && code <= 0x7e) this.sanitizerState = "text";
					break;
				case "osc":
					if (code === 0x07 || code === 0x9c) this.sanitizerState = "text";
					else if (code === 0x1b) this.sanitizerState = "oscEscape";
					break;
				case "oscEscape":
					if (code === 0x07 || code === 0x5c || code === 0x9c) this.sanitizerState = "text";
					else if (code !== 0x1b) this.sanitizerState = "osc";
					break;
			}
		}
		return visible;
	}
}
