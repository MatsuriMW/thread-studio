import {
	type App,
	FuzzySuggestModal,
	Modal,
	type TFile,
} from "obsidian";
import { deferred } from "../deferred";
import { log } from "../log";
import {
	MAX_TWEET_LENGTH,
	splitIntoTweets,
	type ComposeResult,
} from "../tweet";
import { promptForDateTime } from "./DateTimePromptModal";
import { analyzeTweetText } from "../textAnalysis";
import type { XAccount } from "../settings";
import {
	EASE,
	ENTER,
	SHAKE,
	SPRING,
	type IconName,
	icon,
	motionAllowed,
	playSound,
} from "../fx";

export interface ComposeOptions {
	/** Pre-filled thread, one entry per post (edit / thread-from-selection). */
	initialContent?: string[];
	/** Raw text to seed the first post, auto-split when enabled. */
	initialText?: string;
	/** Images attached to the first post when the composer opens. */
	initialAttachments?: TFile[];
	/** Weighted length limit per post. Defaults to 280; X Premium allows 25,000. */
	maxLength?: number;
	/** Show the "Schedule" button alongside the primary action. */
	allowSchedule?: boolean;
	/** Primary button label. Defaults to "Post". */
	submitLabel?: string;
	/** Whether to split content at the character limit. Defaults to true. */
	autoSplit?: boolean;
	/** Accounts available for immediate posting. */
	accounts?: XAccount[];
	/** Account preselected when the composer opens. */
	selectedAccountId?: string;
	/**
	 * Sends the thread while the composer stays open. Resolve `false` when
	 * nothing went out, which keeps the draft open for another try.
	 */
	send?: (result: ComposeResult) => Promise<boolean>;
}

/** Character count starts showing once this many remain. */
const COUNTDOWN_FROM = 30;
/** A run of this many newlines is the "start a new post" gesture. */
const BREAK_RUN = "\n\n\n";
/** Twitter accepts at most four images per post. */
export const MAX_MEDIA = 4;
export const IMAGE_EXTENSIONS: Record<string, true> = {
	gif: true,
	jpg: true,
	jpeg: true,
	tif: true,
	tiff: true,
	png: true,
	webp: true,
	bmp: true,
};

/** Extensions for clipboard image types we can save to the vault. */
const EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
};

/** `YYYYMMDDHHmmss` stamp for pasted-image filenames, matching Obsidian's own. */
function pasteStamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	);
}

/** One composed post: its card, editor, count, attachments, and controls. */
interface PostRow {
	el: HTMLElement;
	node: HTMLElement;
	card: HTMLElement;
	textarea: HTMLTextAreaElement;
	count: HTMLElement;
	countNum: HTMLElement;
	attachEl: HTMLElement;
	attachments: TFile[];
	/** Attachments already on screen, so only new chips pop in. */
	shownAttachments: TFile[];
	moveUp: HTMLButtonElement;
	moveDown: HTMLButtonElement;
	remove: HTMLButtonElement;
}

/** Fuzzy picker over the vault's image files, for attaching media to a post. */
class ImagePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly files: TFile[],
		private readonly onPick: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("Attach an image from your vault\u2026");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

/**
 * Thread composer. One roomy card per post on a connected rail (shown only for
 * threads), with hover controls to attach images, reorder, and delete, a
 * character count that surfaces near the limit, keyboard shortcuts, and a
 * triple-newline gesture to start a new post. Resolves with the composed thread
 * (and an optional `postAt` when scheduled), or `null` if dismissed.
 */
export class ComposeTweetModal extends Modal {
	private readonly rows: PostRow[] = [];
	private thread!: HTMLElement;
	private previewEl!: HTMLElement;
	private modeButtons: HTMLButtonElement[] = [];
	private previewing = false;
	private addEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private postButton!: HTMLButtonElement;
	private postLabel!: HTMLElement;
	private scheduleButton: HTMLButtonElement | null = null;
	private scheduleLabel: HTMLElement | null = null;
	private selectedAccountId = "";
	private submitted = false;
	private sending: "post" | "schedule" | null = null;
	private result: ComposeResult | null = null;

	static compose(
		app: App,
		options: ComposeOptions = {},
	): Promise<ComposeResult | null> {
		const { promise, resolve } = deferred<ComposeResult | null>();
		new ComposeTweetModal(app, options, resolve).open();
		return promise;
	}

	private constructor(
		app: App,
		private readonly options: ComposeOptions,
		private readonly resolve: (result: ComposeResult | null) => void,
	) {
		super(app);
	}

	private get autoSplit(): boolean {
		return this.options.autoSplit ?? true;
	}

	private get limit(): number {
		return this.options.maxLength ?? MAX_TWEET_LENGTH;
	}

	private buildAccountPicker(root: HTMLElement): void {
		const accounts = this.options.accounts ?? [];
		if (this.options.submitLabel === "Update") return;

		const picker = root.createDiv({ cls: "nt-account-picker" });
		picker.createEl("label", { text: "Post from", attr: { for: "nt-account" } });
		if (accounts.length === 0) {
			picker.createSpan({
				cls: "nt-account-empty",
				text: "Add an X account in settings",
			});
			return;
		}

		const selected = accounts.some(
			({ id }) => id === this.options.selectedAccountId,
		)
			? this.options.selectedAccountId
			: accounts[0].id;
		this.selectedAccountId = selected ?? "";
		const avatar = picker.createSpan({
			cls: "nt-avatar",
			attr: { "aria-hidden": "true" },
		});
		const paintAvatar = () =>
			avatar.setText(this.accountName("?").charAt(0).toUpperCase());
		paintAvatar();
		const select = picker.createEl("select", {
			cls: "nt-account-select dropdown",
			attr: { id: "nt-account", "aria-label": "X account" },
		});
		for (const account of accounts) {
			select.createEl("option", { text: account.name, value: account.id });
		}
		select.value = this.selectedAccountId;
		select.addEventListener("change", () => {
			this.selectedAccountId = select.value;
			paintAvatar();
			if (motionAllowed()) {
				avatar.animate(
					[{ transform: "scale(0.6)", opacity: 0.4 }, { transform: "none", opacity: 1 }],
					{ duration: 320, easing: SPRING },
				);
			}
			this.refreshState();
		});
	}

	private accountName(fallback: string): string {
		return (
			(this.options.accounts ?? []).find(({ id }) => id === this.selectedAccountId)
				?.name ?? fallback
		);
	}

	onOpen(): void {
		this.modalEl.addClass("nt-compose-modal");
		this.contentEl.addClass("postTweetModal");
		this.setTitle(
			this.options.submitLabel === "Update"
				? "Edit scheduled post"
				: "Compose post",
		);
		const head = this.contentEl.createDiv({ cls: "nt-head" });
		this.buildAccountPicker(head);
		this.buildModeSwitch(head);

		this.thread = this.contentEl.createDiv({ cls: "nt-thread" });
		this.previewEl = this.contentEl.createDiv({ cls: "nt-preview" });

		try {
			this.seedContent();
		} catch (error) {
			log.warning(String(error));
			this.close();
			return;
		}

		this.buildAddButton(this.contentEl);
		this.buildFooter(this.contentEl);
		this.refreshState();
		if (motionAllowed()) {
			this.rows.forEach((row, index) =>
				row.el.animate(ENTER, {
					duration: 320,
					easing: EASE,
					delay: 40 + Math.min(index, 6) * 45,
					fill: "backwards",
				}),
			);
		}
	}

	/**
	 * Measure, change the layout, then play moved posts, the add button, and the
	 * footer back from where they were. New posts fade in. Only transforms
	 * animate, so the modal never reflows mid-animation.
	 */
	private flip<T>(mutate: () => T): T {
		const els = () => [...this.rows.map((row) => row.el), this.addEl, this.footerEl];
		const before = new Map(els().map((el) => [el, el.getBoundingClientRect()]));
		const result = mutate();
		if (!motionAllowed()) return result;
		for (const el of els()) {
			const was = before.get(el);
			if (!was) {
				el.animate(ENTER, { duration: 300, easing: EASE });
				continue;
			}
			const now = el.getBoundingClientRect();
			const dx = was.left - now.left;
			const dy = was.top - now.top;
			if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
			el.animate(
				[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
				{ duration: 340, easing: EASE },
			);
		}
		return result;
	}

	/** Leave a copy of a deleted post in place and fade it out. */
	private ghost(row: PostRow): void {
		if (!motionAllowed()) return;
		const at = row.el.getBoundingClientRect();
		const base = this.thread.getBoundingClientRect();
		const ghost = row.el.cloneNode(true) as HTMLElement;
		const textarea = ghost.querySelector("textarea");
		if (textarea) textarea.value = row.textarea.value;
		ghost.addClass("nt-ghost");
		ghost.setCssStyles({
			top: `${at.top - base.top}px`,
			left: `${at.left - base.left}px`,
			width: `${at.width}px`,
		});
		this.thread.appendChild(ghost);
		const remove = () => ghost.remove();
		ghost
			.animate(
				[
					{ opacity: 1, transform: "none" },
					{ opacity: 0, transform: "translateX(-12px) scale(0.96)" },
				],
				{ duration: 220, easing: "ease-in", fill: "forwards" },
			)
			.finished.then(remove, remove);
	}

	private seedContent(): void {
		const first = this.makeRow();

		if (this.options.initialContent?.length) {
			this.fillPosts(this.options.initialContent, first);
		} else if (this.options.initialText) {
			const chunks = this.autoSplit
				? splitIntoTweets(this.options.initialText, this.limit)
				: [this.options.initialText];
			this.fillPosts(chunks, first);
		}
		if (this.options.initialAttachments?.length) {
			first.attachments = [...this.options.initialAttachments];
			this.renderAttachments(first);
		}

		this.rows[0]?.textarea.focus();
	}

	private fillPosts(chunks: string[], first: PostRow): void {
		for (const chunk of chunks) {
			const target =
				first.textarea.value.trim() === "" ? first : this.makeRow();
			target.textarea.value = chunk;
			this.update(target);
		}
	}

	/** Build one post card and insert it at `atIndex` (default: append). */
	private makeRow(value = "", atIndex = this.rows.length): PostRow {
		const el = this.thread.createDiv({ cls: "nt-post" });
		const rail = el.createDiv({ cls: "nt-rail" });
		const node = rail.createDiv({ cls: "nt-node" });
		const body = el.createDiv({ cls: "nt-body" });
		const card = body.createDiv({ cls: "nt-card" });

		const editor = card.createDiv({ cls: "nt-editor" });
		const textarea = editor.createEl("textarea", {
			cls: "tweetArea",
			attr: { placeholder: "What do you want to say?", rows: "1" },
		});
		textarea.value = value;
		const count = editor.createDiv({ cls: "nt-count" });
		const countNum = count.createSpan({ cls: "nt-count-num" });
		count.createSpan({ cls: "nt-ring" });

		const attachEl = card.createDiv({ cls: "nt-attachments" });

		const controls = card.createDiv({ cls: "nt-controls" });
		const attach = this.iconButton(controls, "image", "Attach image");
		const moveUp = this.iconButton(controls, "arrow-up", "Move up");
		const moveDown = this.iconButton(controls, "arrow-down", "Move down");
		const remove = this.iconButton(controls, "trash", "Delete post", true);

		const row: PostRow = {
			el,
			node,
			card,
			textarea,
			count,
			countNum,
			attachEl,
			attachments: [],
			shownAttachments: [],
			moveUp,
			moveDown,
			remove,
		};

		if (atIndex < this.rows.length) {
			this.thread.insertBefore(el, this.rows[atIndex].el);
			this.rows.splice(atIndex, 0, row);
		} else {
			this.rows.push(row);
		}

		textarea.addEventListener("input", () => {
			if (this.splitOnBlankLines(row)) return;
			this.update(row);
			this.refreshState();
		});
		textarea.addEventListener("focus", () => this.setActive(row));
		textarea.addEventListener("keydown", (event) =>
			this.handleKeydown(event, row),
		);
		textarea.addEventListener("paste", (event) => this.handlePaste(event, row));

		attach.addEventListener("click", () => this.pickImage(row));
		moveUp.addEventListener("click", () => this.moveRow(row, -1));
		moveDown.addEventListener("click", () => this.moveRow(row, 1));
		remove.addEventListener("click", () => this.deleteRow(row));

		this.update(row);
		return row;
	}

	private iconButton(
		parent: HTMLElement,
		name: IconName,
		label: string,
		danger = false,
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: danger ? "nt-icon-btn nt-danger" : "nt-icon-btn",
			attr: { type: "button", "aria-label": label, title: label },
		});
		icon(button, name);
		return button;
	}

	/** Write / Preview tabs. Preview lays the thread out the way X shows it. */
	private buildModeSwitch(root: HTMLElement): void {
		const tabs = root.createDiv({ cls: "nt-mode", attr: { role: "tablist" } });
		tabs.createSpan({ cls: "nt-mode-pill" });
		const make = (label: string, preview: boolean) => {
			const button = tabs.createEl("button", {
				cls: "nt-mode-btn",
				text: label,
				attr: { type: "button", role: "tab" },
			});
			button.addEventListener("click", () => this.setPreview(preview));
			return button;
		};
		this.modeButtons = [make("Write", false), make("Preview", true)];
		this.modeButtons[0].addClass("is-on");
	}

	private setPreview(on: boolean): void {
		if (this.previewing === on) return;
		this.previewing = on;
		playSound("mode");
		this.contentEl.toggleClass("is-preview", on);
		this.modeButtons.forEach((button, index) =>
			button.toggleClass("is-on", index === (on ? 1 : 0)),
		);
		if (on) {
			this.renderPreview();
			return;
		}
		if (motionAllowed()) {
			this.rows.forEach((row, index) =>
				row.el.animate(ENTER, {
					duration: 260,
					easing: EASE,
					delay: Math.min(index, 6) * 35,
					fill: "backwards",
				}),
			);
		}
		(this.rows.find((row) => row.el.hasClass("is-active")) ?? this.rows[0])
			?.textarea.focus();
	}

	private renderPreview(): void {
		const root = this.previewEl;
		root.empty();
		const name = this.accountName("You");
		const posts = this.rows.filter((row) => !this.isEmpty(row));
		if (posts.length === 0) {
			root.createDiv({ cls: "nt-tw-empty", text: "Nothing to preview yet." });
			return;
		}
		posts.forEach((row, index) => {
			const post = root.createDiv({ cls: "nt-tw" });
			post.setCssProps({ "--i": String(index) });
			post
				.createDiv({ cls: "nt-tw-side" })
				.createSpan({ cls: "nt-avatar", text: name.charAt(0).toUpperCase() });
			const main = post.createDiv({ cls: "nt-tw-main" });
			const meta = main.createDiv({ cls: "nt-tw-meta" });
			meta.createSpan({ cls: "nt-tw-name", text: name });
			meta.createSpan({ cls: "nt-tw-handle", text: `@${name} · now` });
			if (posts.length > 1) {
				meta.createSpan({ cls: "nt-tw-index", text: `${index + 1}/${posts.length}` });
			}
			if (row.textarea.value.trim()) {
				this.previewText(main.createDiv({ cls: "nt-tw-text" }), row.textarea.value);
			}
			if (row.attachments.length > 0) {
				const media = main.createDiv({ cls: `nt-tw-media is-${row.attachments.length}` });
				for (const file of row.attachments) {
					media.createEl("img", {
						attr: { src: this.app.vault.getResourcePath(file), alt: file.name },
					});
				}
			}
			const actions = main.createDiv({ cls: "nt-tw-actions" });
			for (const act of ["reply", "repost", "like", "views"] as const) {
				icon(actions.createSpan({ cls: "nt-tw-act" }), act);
			}
		});
	}

	/**
	 * Post text as the timeline shows it. A long post (X Premium) is cut after
	 * 280 characters with "Show more", like on X; clicking it shows the rest.
	 */
	private previewText(el: HTMLElement, text: string): void {
		const { normalizedText, boundaries, weightedLength } = analyzeTweetText(text);
		if (weightedLength <= MAX_TWEET_LENGTH) {
			this.richText(el, text);
			return;
		}
		let cut =
			boundaries.filter((b) => b.weightedLength <= MAX_TWEET_LENGTH).pop()?.index ?? 0;
		// Prefer ending on a word; text without spaces (CJK) is cut at the limit.
		const space = normalizedText.lastIndexOf(" ", cut);
		if (space > cut - 40) cut = space;
		this.richText(el, `${normalizedText.slice(0, cut).trimEnd()}…`);
		const more = el.createSpan({ cls: "nt-tw-more", text: " Show more" });
		more.addEventListener("click", () => {
			el.empty();
			this.richText(el, normalizedText);
		});
	}

	/** Color links, #hashtags, and @mentions the way X does. */
	private richText(el: HTMLElement, text: string): void {
		let last = 0;
		for (const match of text.matchAll(/https?:\/\/\S+|[#＃][\p{L}\p{N}_]+|@\w{1,15}/gu)) {
			el.appendText(text.slice(last, match.index));
			el.createSpan({ cls: "nt-tw-link", text: match[0] });
			last = match.index + match[0].length;
		}
		el.appendText(text.slice(last));
	}

	private buildAddButton(root: HTMLElement): void {
		const add = root.createEl("button", {
			cls: "nt-add",
			attr: { type: "button" },
		});
		icon(add.createSpan({ cls: "nt-add-icon" }), "plus");
		add.createSpan({ text: "Add post" });
		add.addEventListener("click", () => this.appendRow());
		this.addEl = add;
	}

	private buildFooter(root: HTMLElement): void {
		const footer = root.createDiv({ cls: "nt-footer" });
		this.footerEl = footer;
		const context = footer.createDiv({ cls: "nt-footer-context" });
		this.statusEl = context.createDiv({ cls: "nt-footer-status" });
		if (this.options.allowSchedule) {
			context.createDiv({
				cls: "nt-scheduler-identity",
				text: "Scheduled posts use the scheduler's posting identity.",
			});
		}

		const actions = footer.createDiv({ cls: "nt-footer-actions" });
		if (this.options.allowSchedule) {
			this.scheduleButton = actions.createEl("button", {
				cls: "nt-btn nt-btn-ghost",
				attr: { type: "button" },
			});
			icon(this.scheduleButton, "clock");
			this.scheduleLabel = this.scheduleButton.createSpan({ text: "Schedule" });
			this.scheduleButton.addEventListener("click", () =>
				void this.submitSchedule(),
			);
		}
		this.postButton = actions.createEl("button", {
			cls: "nt-btn nt-btn-cta",
			attr: { type: "button" },
		});
		icon(this.postButton, this.options.submitLabel === "Update" ? "check" : "send");
		this.postLabel = this.postButton.createSpan({
			text: this.options.submitLabel ?? "Post",
		});
		this.postButton.addEventListener("click", () => this.submitPost());
	}

	private pickImage(row: PostRow): void {
		if (row.attachments.length >= MAX_MEDIA) {
			log.warning(`A post can hold at most ${MAX_MEDIA} images.`);
			return;
		}
		const images = this.app.vault
			.getFiles()
			.filter((file) => IMAGE_EXTENSIONS[file.extension.toLowerCase()] === true)
			.filter((file) => !row.attachments.includes(file));
		if (images.length === 0) {
			log.warning("No image files found in your vault.");
			return;
		}
		new ImagePickerModal(this.app, images, (file) => {
			row.attachments.push(file);
			playSound("attach");
			this.renderAttachments(row);
			this.refreshState();
			row.textarea.focus();
		}).open();
	}

	private renderAttachments(row: PostRow): void {
		row.attachEl.empty();
		const shown = new Set(row.shownAttachments);
		row.shownAttachments = [...row.attachments];
		for (const file of row.attachments) {
			const chip = row.attachEl.createDiv({
				cls: shown.has(file) ? "nt-attachment" : "nt-attachment is-new",
			});
			chip.createEl("img", {
				attr: { src: this.app.vault.getResourcePath(file), alt: file.name },
			});
			const remove = chip.createEl("button", {
				cls: "nt-attachment-remove",
				attr: { type: "button", "aria-label": `Remove ${file.name}` },
			});
			icon(remove, "x");
			remove.addEventListener("click", () => {
				playSound("detach");
				row.attachments = row.attachments.filter((item) => item !== file);
				this.renderAttachments(row);
				this.refreshState();
			});
		}
	}

	private setActive(row: PostRow): void {
		for (const other of this.rows) {
			other.el.toggleClass("is-active", other === row);
		}
	}

	/**
	 * Repaint one row's X-weighted character count: a ring that fills toward 280
	 * like X's, the remaining count near the limit, and for a long post (X
	 * Premium) its length, since X folds it after 280 characters.
	 */
	private update(row: PostRow): void {
		const length = analyzeTweetText(row.textarea.value).weightedLength;
		const remaining = this.limit - length;
		const shown = remaining <= COUNTDOWN_FROM;
		const long = !shown && length > MAX_TWEET_LENGTH;
		const over = this.autoSplit && length > this.limit;
		const wasOver = row.el.hasClass("is-over");

		row.count.setCssProps({
			"--nt-p": String(Math.min(length / MAX_TWEET_LENGTH, 1)),
		});
		row.count.toggleClass("is-empty", length === 0);
		row.count.toggleClass("is-shown", shown);
		row.count.toggleClass("is-long", long);
		row.count.toggleClass("is-over", over);
		row.el.toggleClass("is-over", over);
		row.countNum.setText(
			shown ? String(remaining) : long ? length.toLocaleString("en-US") : "",
		);
		if (over && !wasOver) {
			playSound("over");
			if (motionAllowed()) row.card.animate(SHAKE, { duration: 360, easing: "ease-out" });
		}
	}

	/**
	 * Recompute thread-wide chrome: rail visibility, node numbering, control
	 * availability, and the footer validity that gates the actions.
	 */
	private refreshState(): void {
		const count = this.rows.length;
		this.thread.toggleClass("is-single", count <= 1);

		this.rows.forEach((row, index) => {
			row.node.setText(String(index + 1));
			row.moveUp.disabled = index === 0;
			row.moveDown.disabled = index === count - 1;
			row.remove.disabled = count === 1 && this.isEmpty(row);
		});

		const { ok, reason } = this.validate();
		this.statusEl.setText(reason ?? "");
		this.statusEl.toggleClass("is-blocked", Boolean(reason));
		const requiresAccount = this.options.submitLabel !== "Update";
		this.postButton.disabled =
			!ok ||
			Boolean(this.sending) ||
			(requiresAccount && this.selectedAccountId === "");
		this.postButton.toggleClass("is-sending", this.sending === "post");
		this.postLabel.setText(
			this.sending === "post"
				? "Posting\u2026"
				: (this.options.submitLabel ?? "Post"),
		);
		if (this.scheduleButton && this.scheduleLabel) {
			this.scheduleButton.disabled = !ok || Boolean(this.sending);
			this.scheduleLabel.setText(
				this.sending === "schedule" ? "Scheduling\u2026" : "Schedule",
			);
		}
		if (this.previewing) this.renderPreview();
	}

	private handlePaste(event: ClipboardEvent, row: PostRow): void {
		const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
			file.type.startsWith("image/"),
		);
		if (images.length > 0) {
			event.preventDefault();
			void this.attachPastedImages(row, images);
			return;
		}

		if (!this.autoSplit) return;
		const pasted = event.clipboardData?.getData("text") ?? "";
		const start = row.textarea.selectionStart;
		const end = row.textarea.selectionEnd;
		const combined =
			row.textarea.value.slice(0, start) +
			pasted +
			row.textarea.value.slice(end);
		if (analyzeTweetText(combined).weightedLength <= this.limit) return;
		event.preventDefault();
		this.flip(() => {
			this.replaceRowWithPosts(row, splitIntoTweets(combined, this.limit));
			this.refreshState();
		});
		playSound("split");
	}

	private replaceRowWithPosts(row: PostRow, chunks: string[]): void {
		const index = this.rows.indexOf(row);
		row.textarea.value = chunks[0] ?? "";
		this.update(row);
		for (let offset = 1; offset < chunks.length; offset++) {
			this.makeRow(chunks[offset], index + offset);
		}
	}

	/** Save clipboard images into the vault, then attach them to the post. */
	private async attachPastedImages(row: PostRow, files: File[]): Promise<void> {
		for (const file of files) {
			if (row.attachments.length >= MAX_MEDIA) {
				log.warning(`A post can hold at most ${MAX_MEDIA} images.`);
				break;
			}
			const extension = EXTENSION_BY_MIME[file.type];
			if (!extension) {
				log.warning(`Unsupported image type: ${file.type}.`);
				continue;
			}
			try {
				const name = `Pasted image ${pasteStamp()}.${extension}`;
				const path = await this.app.fileManager.getAvailablePathForAttachment(name);
				const saved = await this.app.vault.createBinary(path, await file.arrayBuffer());
				row.attachments.push(saved);
				playSound("attach");
				this.renderAttachments(row);
				this.refreshState();
			} catch (error) {
				log.error(`Could not save the pasted image: ${String(error)}`);
			}
		}
	}

	private handleKeydown(event: KeyboardEvent, row: PostRow): void {
		const index = this.rows.indexOf(row);
		const empty = row.textarea.value.length === 0;

		if (event.code === "Backspace" && empty && this.rows.length > 1) {
			event.preventDefault();
			this.deleteRow(row);
			return;
		}

		const enter = event.code === "Enter" || event.code === "NumpadEnter";

		if (
			(event.code === "Enter" &&
				analyzeTweetText(row.textarea.value).weightedLength >= this.limit &&
				this.autoSplit) ||
			(enter && event.altKey)
		) {
			event.preventDefault();
			this.appendRow();
			return;
		}

		if (event.code === "Enter" && event.shiftKey) {
			event.preventDefault();
			this.insertRow(index);
			return;
		}

		if (event.code === "Enter" && event.ctrlKey) {
			event.preventDefault();
			this.insertRow(index + 1);
			return;
		}

		if (event.ctrlKey && !event.shiftKey && event.code === "ArrowUp" && index > 0) {
			this.rows[index - 1].textarea.focus();
			return;
		}
		if (
			event.ctrlKey &&
			!event.shiftKey &&
			event.code === "ArrowDown" &&
			index < this.rows.length - 1
		) {
			this.rows[index + 1].textarea.focus();
			return;
		}

		if (
			event.ctrlKey &&
			event.shiftKey &&
			event.code === "ArrowDown" &&
			index < this.rows.length - 1
		) {
			event.preventDefault();
			this.swapRows(index, index + 1);
			return;
		}
		if (event.ctrlKey && event.shiftKey && event.code === "ArrowUp" && index > 0) {
			event.preventDefault();
			this.swapRows(index, index - 1);
			return;
		}

		if (event.ctrlKey && event.shiftKey && event.code === "Delete") {
			event.preventDefault();
			this.deleteRow(row);
		}
	}

	/** Split the current post at the first run of blank lines. */
	private splitOnBlankLines(row: PostRow): boolean {
		const value = row.textarea.value;
		const index = value.indexOf(BREAK_RUN);
		if (index === -1) return false;

		const next = this.flip(() => {
			row.textarea.value = value.slice(0, index);
			this.update(row);
			const made = this.makeRow(
				value.slice(index + BREAK_RUN.length),
				this.rows.indexOf(row) + 1,
			);
			this.refreshState();
			return made;
		});
		playSound("split");
		next.textarea.focus();
		next.textarea.setSelectionRange(0, 0);
		return true;
	}

	private appendRow(): PostRow | null {
		if (this.rows.some((row) => this.isEmpty(row))) {
			log.warning("Finish the empty post before adding another.");
			return null;
		}
		const row = this.flip(() => {
			const made = this.makeRow();
			this.refreshState();
			return made;
		});
		playSound("add");
		row.textarea.focus();
		return row;
	}

	private insertRow(index: number): void {
		if (this.rows.some((row) => this.isEmpty(row))) {
			log.warning("Finish the empty post before adding another.");
			return;
		}
		const row = this.flip(() => {
			const made = this.makeRow("", index);
			this.refreshState();
			return made;
		});
		playSound("add");
		row.textarea.focus();
	}

	private deleteRow(row: PostRow): void {
		playSound("remove");
		if (this.rows.length === 1) {
			row.textarea.value = "";
			row.attachments = [];
			this.renderAttachments(row);
			this.update(row);
			this.refreshState();
			return;
		}
		const index = this.rows.indexOf(row);
		this.ghost(row);
		this.flip(() => {
			this.rows.splice(index, 1);
			row.el.remove();
			this.refreshState();
		});
		this.rows[index === 0 ? 0 : index - 1]?.textarea.focus();
	}

	private swapRows(a: number, b: number): void {
		this.flip(() => {
			[this.rows[a], this.rows[b]] = [this.rows[b], this.rows[a]];
			this.thread.insertBefore(
				this.rows[Math.min(a, b)].el,
				this.rows[Math.max(a, b)].el,
			);
			this.refreshState();
		});
		playSound("move");
		this.rows[b].textarea.focus();
	}

	private moveRow(row: PostRow, direction: -1 | 1): void {
		const index = this.rows.indexOf(row);
		const target = index + direction;
		if (target < 0 || target >= this.rows.length) return;
		this.swapRows(index, target);
	}

	private isEmpty(row: PostRow): boolean {
		return row.textarea.value.length === 0 && row.attachments.length === 0;
	}

	/**
	 * Validate the thread. `ok` is true when every post has text or an image and
	 * none exceed the limit (when auto-split is on); `reason` explains a block, or
	 * is `null` when the thread is simply untouched.
	 */
	private validate(): { ok: boolean; reason: string | null } {
		if (this.rows.every((row) => this.isEmpty(row))) {
			return { ok: false, reason: null };
		}
		if (
			this.autoSplit &&
			this.rows.some(
				(row) => analyzeTweetText(row.textarea.value).weightedLength > this.limit,
			)
		) {
			return {
				ok: false,
				reason: `A post is over ${this.limit.toLocaleString("en-US")} characters`,
			};
		}
		if (this.rows.some((row) => this.isEmpty(row))) {
			return { ok: false, reason: "A post in the thread is empty" };
		}
		return { ok: true, reason: null };
	}

	/** Compose the postable text for each row, appending image links at the end. */
	private collectContent(): string[] {
		return this.rows.map((row) => {
			const text = row.textarea.value;
			if (row.attachments.length === 0) return text;
			const links = row.attachments.map((file) => `[[${file.path}]]`).join(" ");
			return text.length > 0 ? `${text}\n${links}` : links;
		});
	}

	private submitPost(): void {
		const requiresAccount = this.options.submitLabel !== "Update";
		if (
			this.sending ||
			!this.validate().ok ||
			(requiresAccount && !this.selectedAccountId)
		)
			return;
		playSound("send");
		void this.submit({
			content: this.collectContent(),
			...(this.selectedAccountId
				? { accountId: this.selectedAccountId }
				: {}),
		});
	}

	private async submitSchedule(): Promise<void> {
		if (this.sending || !this.validate().ok) return;

		const postAt = await promptForDateTime(this.app);
		if (postAt === null) return;

		playSound("schedule");
		await this.submit({ content: this.collectContent(), postAt });
	}

	private async submit(result: ComposeResult): Promise<void> {
		if (this.options.send) {
			// Freeze the draft so edits made mid-send can't be lost on success.
			this.setSending(result.postAt == null ? "post" : "schedule");
			let sent = false;
			try {
				sent = await this.options.send(result);
			} catch (error) {
				log.error(String(error));
			} finally {
				this.setSending(null);
			}
			if (!sent) {
				// Going inert dropped focus; hand it back unless another modal took it.
				if (activeDocument.activeElement === activeDocument.body) {
					(this.rows.find((row) => row.el.hasClass("is-active")) ?? this.rows[0])
						?.textarea.focus();
				}
				return;
			}
		}
		this.result = result;
		this.submitted = true;
		this.close();
	}

	private setSending(sending: "post" | "schedule" | null): void {
		this.sending = sending;
		this.contentEl.toggleAttribute("inert", sending !== null);
		this.refreshState();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.submitted ? this.result : null);
	}
}
