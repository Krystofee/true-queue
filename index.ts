/**
 * True Queue Extension
 *
 * Solves the "goal anchoring" problem: when an agent sees multiple future tasks,
 * it rushes through the current one. This extension lets users enqueue tasks with
 * "+" prefix — the agent never sees queued tasks until the current one is done.
 *
 * Usage:
 *   Normal input         → steer (agent sees immediately)
 *   +do something        → enqueue (starts automatically when current task ends)
 *   ++do something       → enqueue with confirm before starting
 *
 * Commands:
 *   /queue               → show queue / open edit mode
 *   /queue add <task>    → add a task
 *   /queue clear         → clear all
 *   /queue done          → mark current done, start next
 *   /queue skip          → drop current task
 *   /queue pause/resume  → pause/resume auto-dequeue
 *
 * Shortcuts:
 *   Ctrl+Q               → open queue editor overlay
 *
 * Tool:
 *   enqueue_task         → let the agent queue a task when the user explicitly asks
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type Focusable, matchesKey, type OverlayHandle, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

/**
 * Flatten any text to a single display line.
 * Replaces CR/LF/tabs/multiple spaces with a single space so multi-line
 * tasks don't break widget/list layout.
 */
function singleLineDisplay(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function isMultiline(text: string): boolean {
	return /[\r\n]/.test(text);
}

const DEQUEUE_DELAY_MS = 1000;

interface QueueItem {
	text: string;
	confirm: boolean;
}

interface QueueState {
	queue: QueueItem[];
	currentTask: string | null;
	paused: boolean;
	pauseReason?: string;
}

function emptyState(): QueueState {
	return { queue: [], currentTask: null, paused: false };
}

export default function (pi: ExtensionAPI) {
	const state: QueueState = emptyState();
	let dequeueTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTimers() {
		if (dequeueTimer) clearTimeout(dequeueTimer);
		dequeueTimer = null;
	}

	function normalize(text: string) {
		return text.replace(/^\[queued task\]\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
	}

	function isDuplicate(text: string) {
		const n = normalize(text);
		if (state.currentTask && normalize(state.currentTask) === n) return "active" as const;
		const pos = state.queue.findIndex((t) => normalize(t.text) === n);
		if (pos >= 0) return pos + 1;
		return false;
	}

	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	}

	function persist() {
		pi.appendEntry("true-queue-state", { ...state, queue: [...state.queue] });
	}

	function loadState(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch() as any[];
		let restored = emptyState();

		for (const entry of branch) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== "true-queue-state" && entry.customType !== "task-queue-state") continue;
			const d = entry.data;
			if (!d || typeof d !== "object") continue;

			restored = emptyState();
			if (Array.isArray(d.queue)) {
				restored.queue = d.queue
					.filter((t: any) => t && typeof t.text === "string" && t.text.trim())
					.map((t: any) => ({ text: t.text.trim(), confirm: Boolean(t.confirm) }));
			}
			if (typeof d.currentTask === "string") {
				restored.currentTask = d.currentTask.trim() || null;
			} else if (d.currentTask && typeof d.currentTask.text === "string") {
				restored.currentTask = d.currentTask.text.trim() || null;
			}
			restored.paused = Boolean(d.paused);
			if (typeof d.pauseReason === "string" && d.pauseReason.trim()) {
				restored.pauseReason = d.pauseReason.trim();
			}
		}

		Object.assign(state, restored);
		clearTimers();
	}

	function enqueue(text: string, confirm: boolean, ctx: ExtensionContext) {
		const trimmed = text.trim();
		if (!trimmed) return { added: false as const, reason: "empty" as const };

		const dup = isDuplicate(trimmed);
		if (dup === "active") return { added: false as const, reason: "active" as const };
		if (dup !== false) return { added: false as const, reason: "queued" as const, position: dup };

		state.queue.push({ text: trimmed, confirm });
		persist();
		updateWidget(ctx);
		return { added: true as const, position: state.queue.length };
	}

	async function startNext(ctx: ExtensionContext) {
		while (state.queue.length > 0) {
			const next = state.queue[0];

			if (next.confirm) {
				if (!ctx.hasUI) {
					state.paused = true;
					state.pauseReason = "Next task requires confirmation (no UI).";
					persist();
					updateWidget(ctx);
					return;
				}
				const preview = next.text.length > 80 ? next.text.slice(0, 80) + "…" : next.text;
				if (!(await ctx.ui.confirm("Next task", `Start this queued task?\n\n${preview}`))) {
					state.queue.shift();
					persist();
					updateWidget(ctx);
					continue;
				}
			}

			const task = state.queue.shift()!;
			state.currentTask = task.text;
			state.pauseReason = undefined;
			persist();
			updateWidget(ctx);

			const prompt = `[Queued task]\n\n${task.text}`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}
			return;
		}

		updateWidget(ctx);
	}

	async function advance(ctx: ExtensionContext) {
		if (state.paused || state.queue.length === 0) return;
		state.currentTask = null;
		persist();
		await startNext(ctx);
	}

	function scheduleAdvance(ctx: ExtensionContext) {
		clearTimers();
		dequeueTimer = setTimeout(async () => {
			dequeueTimer = null;
			try {
				if (ctx.hasPendingMessages()) return;
				await advance(ctx);
			} catch (error) {
				console.error(`[true-queue] Advance error: ${error}`);
			}
		}, DEQUEUE_DELAY_MS);
	}

	// ── Widget ──

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (state.queue.length > 0 || state.currentTask) {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus("true-queue", theme.fg("dim", "ctrl+q queue"));
		} else {
			ctx.ui.setStatus("true-queue", undefined);
		}
	}

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		updateStatus(ctx);

		if (!state.currentTask && state.queue.length === 0 && !state.paused) {
			ctx.ui.setWidget("true-queue", undefined);
			return;
		}

		ctx.ui.setWidget("true-queue", (_tui, theme) => {
			return {
				render: (width: number) => renderWidgetLines(theme, width),
				invalidate: () => {},
			};
		});
	}

	function renderWidgetLines(theme: Theme, width: number): string[] {
		const lines: string[] = [];

		if (state.currentTask) {
			const pauseIcon = state.paused ? theme.fg("warning", " ⏸") : "";
			const multiIcon = isMultiline(state.currentTask) ? theme.fg("dim", "↵ ") : "";
			const flat = singleLineDisplay(state.currentTask);
			lines.push(
				truncateToWidth(
					theme.fg("accent", "🎯 ") + multiIcon + theme.fg("toolTitle", flat) + pauseIcon,
					width,
				),
			);
		} else if (state.paused) {
			lines.push(theme.fg("warning", "⏸ Queue paused"));
		}

		if (state.queue.length > 0) {
			for (let i = 0; i < state.queue.length; i++) {
				const t = state.queue[i];
				const num = theme.fg("dim", `${i + 1}.`);
				const confirmIcon = t.confirm ? theme.fg("warning", "◉ ") : "";
				const multiIcon = isMultiline(t.text) ? theme.fg("dim", "↵ ") : "";
				const flat = singleLineDisplay(t.text);
				lines.push(truncateToWidth(`  ${num} ${confirmIcon}${multiIcon}${theme.fg("muted", flat)}`, width));
			}
		}

		if (state.paused && state.pauseReason) {
			lines.push(truncateToWidth(theme.fg("dim", `   ${singleLineDisplay(state.pauseReason)}`), width));
		}

		return lines;
	}

	// ── Queue Editor Overlay ──

	async function openQueueEditor(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (state.queue.length === 0 && !state.currentTask) {
			notify(ctx, "Queue is empty", "info");
			return;
		}

		let overlayHandle: OverlayHandle | undefined;

		// Open ctx.ui.editor() while temporarily hiding our overlay.
		// This gives us a full multi-line editor (with history, Ctrl+G external
		// editor support, etc.) for adding/editing tasks instead of the cramped
		// inline input that couldn't handle newlines.
		const runEditor = async (title: string, prefill: string): Promise<string | undefined> => {
			const wasHidden = overlayHandle?.isHidden() ?? false;
			overlayHandle?.setHidden(true);
			try {
				return await ctx.ui.editor(title, prefill);
			} finally {
				overlayHandle?.setHidden(wasHidden);
			}
		};

		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const editor = new QueueEditor(
					theme,
					state,
					done,
					() => {
						persist();
						updateWidget(ctx);
						tui.requestRender();
					},
					runEditor,
				);
				return editor;
			},
			{
				overlay: true,
				onHandle: (h) => {
					overlayHandle = h;
				},
			},
		);
	}

	// ── Session lifecycle ──

	function refresh(ctx: ExtensionContext) {
		loadState(ctx);
		updateWidget(ctx);
	}

	pi.on("session_start", async (_e, ctx) => refresh(ctx));
	pi.on("session_switch", async (_e, ctx) => refresh(ctx));
	pi.on("session_fork", async (_e, ctx) => refresh(ctx));
	pi.on("session_tree", async (_e, ctx) => refresh(ctx));
	pi.on("session_shutdown", async () => clearTimers());

	// ── Input handler ──

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const text = event.text.trim();
		const withConfirm = text.startsWith("++");
		const queued = withConfirm ? text.slice(2).trim() : text.startsWith("+") ? text.slice(1).trim() : null;
		if (queued === null) return { action: "continue" as const };
		if (!queued) return { action: "handled" as const };

		const result = enqueue(queued, withConfirm, ctx);
		if (!result.added) {
			if (result.reason === "active") notify(ctx, "That task is already active.", "warning");
			else if (result.reason === "queued") notify(ctx, `Already queued at position ${result.position}.`, "info");
			return { action: "handled" as const };
		}

		if (ctx.isIdle() && !state.currentTask && !state.paused) {
			await advance(ctx);
		}

		return { action: "handled" as const };
	});

	// ── Agent end ──

	pi.on("agent_end", async (_event, ctx) => {
		if (state.queue.length === 0) {
			if (state.currentTask) {
				state.currentTask = null;
				persist();
				updateWidget(ctx);
			}
			return;
		}
		if (state.paused) return;
		scheduleAdvance(ctx);
	});

	// ── Shortcut ──

	pi.registerShortcut("ctrl+q", {
		description: "Open queue editor",
		handler: async (ctx) => {
			await openQueueEditor(ctx);
		},
	});

	// ── Tool ──

	pi.registerTool({
		name: "enqueue_task",
		label: "Enqueue Task",
		description: "Add a task to the deferred task queue. Use only when the user explicitly asks you to queue or defer something for later.",
		promptSnippet: "Add a task to the deferred task queue for later execution.",
		promptGuidelines: [
			"Use enqueue_task only when the user explicitly asks to queue, defer, or save a task for later.",
			"Do not use enqueue_task for your own internal planning unless the user asked for it.",
			"Never use enqueue_task for the task that is currently active — work on that task instead.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task text to enqueue" }),
			confirm: Type.Optional(
				Type.Boolean({ description: "Require user confirmation before starting this queued task", default: false }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = enqueue(params.task, params.confirm ?? false, ctx);
			if (!result.added) {
				if (result.reason === "active") {
					throw new Error("This task is already active. Work on it now instead of queueing it again.");
				}
				return {
					content: [{ type: "text", text: `Already queued at position ${result.position}: ${params.task}` }],
					details: { duplicate: true, position: result.position },
				};
			}
			return {
				content: [{ type: "text", text: `Queued at position ${result.position}: ${params.task}` }],
				details: { position: result.position },
			};
		},
	});

	// ── Command ──

	pi.registerCommand("queue", {
		description: "Manage the task queue",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			if (!sub || sub === "edit") {
				await openQueueEditor(ctx);
				return;
			}

			if (sub === "add") {
				const task = args.trim().slice(3).trim();
				if (!task) {
					notify(ctx, "Usage: /queue add <task>", "warning");
					return;
				}
				const result = enqueue(task, false, ctx);
				if (!result.added) {
					notify(ctx, result.reason === "active" ? "Already active." : `Already queued at #${result.position}.`, "warning");
				} else {
					notify(ctx, `Queued at position ${result.position}`, "info");
				}
				return;
			}

			if (sub === "clear") {
				state.queue = [];
				persist();
				updateWidget(ctx);
				notify(ctx, "Queue cleared", "info");
				return;
			}

			if (sub === "done" || sub === "next") {
				if (!state.currentTask) {
					notify(ctx, "No current task", "warning");
					if (!state.paused && state.queue.length > 0 && ctx.isIdle()) await startNext(ctx);
					return;
				}
				const finished = state.currentTask;
				state.currentTask = null;
				persist();
				updateWidget(ctx);
				notify(ctx, `Done: "${finished.slice(0, 60)}"`, "info");
				if (!state.paused && state.queue.length > 0) await startNext(ctx);
				return;
			}

			if (sub === "skip") {
				if (!state.currentTask) {
					notify(ctx, "No current task", "warning");
					return;
				}
				state.currentTask = null;
				persist();
				updateWidget(ctx);
				notify(ctx, "Current task skipped", "info");
				return;
			}

			if (sub === "pause") {
				state.paused = true;
				state.pauseReason = "Paused by user.";
				persist();
				updateWidget(ctx);
				notify(ctx, "Queue paused", "info");
				return;
			}

			if (sub === "resume") {
				state.paused = false;
				state.pauseReason = undefined;
				persist();
				updateWidget(ctx);
				if (ctx.isIdle() && state.queue.length > 0) await advance(ctx);
				return;
			}

			notify(ctx, `Unknown subcommand: ${sub}. Try: add, clear, done, skip, pause, resume, edit`, "warning");
		},
	});
}

// ── Queue Editor Component ──

class QueueEditor implements Focusable {
	focused = false;
	private selected = 0;
	/**
	 * When true, the multi-line editor dialog is open in front of this overlay.
	 * We ignore keypresses in this state so the user's input goes to the editor.
	 */
	private busy = false;

	constructor(
		private theme: Theme,
		private state: QueueState,
		private done: (result: void) => void,
		private onChange: () => void,
		private runEditor: (title: string, prefill: string) => Promise<string | undefined>,
	) {}

	handleInput(data: string): void {
		if (this.busy) return;

		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done();
			return;
		}

		const qLen = this.state.queue.length;

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.selected > 0) this.selected--;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.selected < qLen - 1) this.selected++;
		} else if (matchesKey(data, "shift+up") || matchesKey(data, "K")) {
			if (this.selected > 0 && qLen > 1) {
				const tmp = this.state.queue[this.selected];
				this.state.queue[this.selected] = this.state.queue[this.selected - 1];
				this.state.queue[this.selected - 1] = tmp;
				this.selected--;
				this.onChange();
			}
		} else if (matchesKey(data, "shift+down") || matchesKey(data, "J")) {
			if (this.selected < qLen - 1 && qLen > 1) {
				const tmp = this.state.queue[this.selected];
				this.state.queue[this.selected] = this.state.queue[this.selected + 1];
				this.state.queue[this.selected + 1] = tmp;
				this.selected++;
				this.onChange();
			}
		} else if (matchesKey(data, "d") || matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			if (qLen > 0) {
				this.state.queue.splice(this.selected, 1);
				if (this.selected >= this.state.queue.length && this.selected > 0) this.selected--;
				this.onChange();
			}
		} else if (matchesKey(data, "a")) {
			void this.addTask();
		} else if (matchesKey(data, "e") || matchesKey(data, "return")) {
			if (this.selected < qLen) void this.editTask(this.selected);
		} else if (matchesKey(data, "c")) {
			if (this.selected < qLen) {
				this.state.queue[this.selected].confirm = !this.state.queue[this.selected].confirm;
				this.onChange();
			}
		} else if (matchesKey(data, "p")) {
			this.state.paused = !this.state.paused;
			this.state.pauseReason = this.state.paused ? "Paused by user." : undefined;
			this.onChange();
		}
	}

	private async addTask(): Promise<void> {
		this.busy = true;
		this.onChange();
		try {
			const result = await this.runEditor("Add queued task", "");
			const text = result?.trim();
			if (text) {
				this.state.queue.push({ text, confirm: false });
				this.selected = this.state.queue.length - 1;
				this.onChange();
			}
		} finally {
			this.busy = false;
			this.onChange();
		}
	}

	private async editTask(index: number): Promise<void> {
		if (index < 0 || index >= this.state.queue.length) return;
		this.busy = true;
		this.onChange();
		try {
			const current = this.state.queue[index];
			const result = await this.runEditor("Edit queued task", current.text);
			if (result === undefined) return;
			const text = result.trim();
			if (!text) {
				// Empty on save = delete.
				this.state.queue.splice(index, 1);
				if (this.selected >= this.state.queue.length && this.selected > 0) this.selected--;
				this.onChange();
				return;
			}
			if (index < this.state.queue.length) {
				this.state.queue[index].text = text;
				this.onChange();
			}
		} finally {
			this.busy = false;
			this.onChange();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = width - 4;
		const lines: string[] = [];

		const row = (content: string) => "  " + truncateToWidth(content, innerW);

		// Header
		lines.push(row(th.fg("border", "─".repeat(Math.min(innerW, 50)))));
		const pauseLabel = this.state.paused ? th.fg("warning", " [PAUSED]") : "";
		lines.push(row(th.fg("accent", th.bold("📋 Queue Editor")) + pauseLabel));
		lines.push(row(""));

		// Current task — always flattened to a single line.
		if (this.state.currentTask) {
			const multiIcon = isMultiline(this.state.currentTask) ? th.fg("dim", "↵ ") : "";
			const flat = singleLineDisplay(this.state.currentTask);
			lines.push(row(th.fg("dim", "Current: ") + multiIcon + th.fg("toolTitle", flat)));
			lines.push(row(""));
		}

		// Queue items — always one line per entry.
		if (this.state.queue.length === 0) {
			lines.push(row(th.fg("dim", "  (empty queue)")));
		} else {
			for (let i = 0; i < this.state.queue.length; i++) {
				const item = this.state.queue[i];
				const isSelected = i === this.selected;
				const prefix = isSelected ? th.fg("accent", "▸ ") : "  ";
				const num = th.fg("dim", `${i + 1}.`);
				const confirmIcon = item.confirm ? th.fg("warning", "◉ ") : "";
				const multiIcon = isMultiline(item.text) ? th.fg("dim", "↵ ") : "";
				const flat = singleLineDisplay(item.text);
				const textColor = isSelected ? "text" : "muted";
				lines.push(row(`${prefix}${num} ${confirmIcon}${multiIcon}${th.fg(textColor, flat)}`));
			}
		}

		// Help
		lines.push(row(""));
		if (this.busy) {
			lines.push(row(th.fg("dim", "editing in multi-line editor…")));
		} else {
			lines.push(row(th.fg("dim", "↑↓ navigate • ⇧↑↓ reorder • a add • e edit • d delete")));
			lines.push(row(th.fg("dim", "c toggle confirm • p pause • esc close")));
		}
		lines.push(row(th.fg("border", "─".repeat(Math.min(innerW, 50)))));

		return lines;
	}

	invalidate(): void {}
}
