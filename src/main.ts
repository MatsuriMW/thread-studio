import { type Editor, MarkdownView, Notice, Plugin, type TFile } from "obsidian";
import type { PostedTweet } from "./xApi";
import {
	DEFAULT_SETTINGS,
	normalizeAccountSettings,
	type NoteTweetSettings,
} from "./settings";
import { NoteTweetSettingsTab } from "./settingsTab";
import { ThreadPostError, TwitterClient } from "./twitter";
import { SelfHostedScheduler } from "./scheduler";
import {
	ComposeTweetModal,
	type ComposeOptions,
	IMAGE_EXTENSIONS,
	MAX_MEDIA,
} from "./Modals/ComposeTweetModal";
import { TweetsPostedModal } from "./Modals/TweetsPostedModal";
import { ArticleModal } from "./Modals/ArticleModal";
import { log } from "./log";
import {
	type ComposeResult,
	MAX_LONG_POST_LENGTH,
	MAX_TWEET_LENGTH,
	parseThread,
	type ScheduledTweet,
} from "./tweet";
import { blockAtCursor } from "./block";
import { articleTitle, noteToArticle } from "./article";
import { icon, playSound, setSoundEnabled } from "./fx";
import {
	clearFixedTwitterSecrets,
	type LegacyCredentialData,
	legacyCredentialsPresent,
	assignSchedulerPasswordKey,
	resolveSchedulerPassword,
	stageFixedSecretMigration,
} from "./migration";
import { getAccountCredentials, type TwitterCredentials } from "./secrets";

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : "Unknown error";
}

export default class NoteTweet extends Plugin {
	settings!: NoteTweetSettings;
	scheduler: SelfHostedScheduler | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		setSoundEnabled(this.settings.soundEffects);
		if (assignSchedulerPasswordKey(this.settings)) {
			await this.saveSettings();
		}
		const migrated = stageFixedSecretMigration(this.app, this.settings);
		if (migrated) {
			await this.saveSettings();
			clearFixedTwitterSecrets(this.app);
			new Notice(
				`Thread Studio: existing credentials moved to the ${migrated.name} account.`,
			);
		}
		this.refreshScheduler();

		this.addCommand({
			id: "post-tweet",
			name: "Post tweet",
			callback: () => void this.composeAndPost(),
		});
		this.addCommand({
			id: "post-selected-as-tweet",
			name: "Post selection as tweet",
			editorCallback: (editor) => void this.postSelection(editor),
		});
		this.addCommand({
			id: "post-file-as-thread",
			name: "Post file as thread",
			callback: () => void this.postFileAsThread(),
		});
		this.addCommand({
			id: "post-current-block",
			name: "Post current block",
			editorCallback: (editor, view) => void this.postCurrentBlock(editor, view.file),
		});
		this.addCommand({
			id: "post-note-as-article",
			name: "Post note as X Article",
			callback: () => void this.postNoteAsArticle(),
		});
		this.addRibbonIcon("send", "Post current block", () => {
			const view = this.app.workspace.getMostRecentLeaf()?.view;
			if (!(view instanceof MarkdownView)) {
				log.warning("Open a Markdown note first.");
				return;
			}
			void this.postCurrentBlock(view.editor, view.file);
		});
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				if (editor.somethingSelected()) {
					menu.addItem((item) =>
						item
							.setTitle("Compose post from selection")
							.setIcon("send")
							.onClick(() => void this.composeAndPost()),
					);
					return;
				}
				if (!blockAtCursor(editor)) return;
				menu.addItem((item) =>
					item
						.setTitle("Post current block")
						.setIcon("send")
						.onClick(() => void this.postCurrentBlock(editor, view.file)),
				);
			}),
		);

		this.addSettingTab(new NoteTweetSettingsTab(this.app, this));

		if (legacyCredentialsPresent(this.legacyData())) {
			new Notice(
				"Thread Studio: open settings to move your credentials into secure storage.",
			);
		}
	}

	async loadSettings(): Promise<void> {
		const loaded = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		this.settings.accounts = Array.isArray(loaded.accounts)
			? (loaded.accounts as NoteTweetSettings["accounts"])
			: [];
		this.settings.scheduling = Object.assign(
			{},
			DEFAULT_SETTINGS.scheduling,
			this.settings.scheduling,
		);
		normalizeAccountSettings(this.settings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Build and verify an account-scoped client for one direct posting action. */
	async connectAccount(accountId: string): Promise<TwitterClient> {
		const client = new TwitterClient(this.app);
		const exists = this.settings.accounts.some(({ id }) => id === accountId);
		if (exists) await client.connect(getAccountCredentials(this.app, accountId));
		return client;
	}

	async verifyCredentials(credentials: TwitterCredentials): Promise<boolean> {
		return new TwitterClient(this.app).connect(credentials);
	}

	/** Rebuild the scheduler from current settings, or clear it when disabled. */
	refreshScheduler(): void {
		const { enabled, url } = this.settings.scheduling;
		if (!enabled || !url) {
			this.scheduler = null;
			return;
		}
		const password =
			resolveSchedulerPassword(this.app, this.settings);
		this.scheduler = new SelfHostedScheduler(url, password);
	}

	/** The persisted settings viewed as the legacy shape, for migration reads. */
	legacyData(): LegacyCredentialData {
		return this.settings as unknown as LegacyCredentialData;
	}

	private currentSelection(): string | null {
		const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		return editor?.somethingSelected() ? editor.getSelection() : null;
	}

	/**
	 * Open the composer. `preset` seeds it instead of the editor selection;
	 * `tagSource` tags the source block once posted, instead of the default
	 * search-and-tag of the posted text.
	 */
	private async composeAndPost(
		preset?: Pick<ComposeOptions, "initialText" | "initialAttachments">,
		tagSource?: () => Promise<void>,
	): Promise<void> {
		const options: ComposeOptions = {
			allowSchedule: this.settings.scheduling.enabled,
			autoSplit: this.settings.autoSplitTweets,
			maxLength: this.settings.premiumLongPosts ? MAX_LONG_POST_LENGTH : MAX_TWEET_LENGTH,
			accounts: this.settings.accounts,
			selectedAccountId: this.settings.defaultAccountId,
			send: (result) => this.send(result, tagSource),
			...preset,
		};

		const selection = preset ? null : this.currentSelection();
		if (selection) {
			try {
				options.initialContent = parseThread(selection);
			} catch {
				options.initialText = selection;
			}
		}

		await ComposeTweetModal.compose(this.app, options);
	}

	/** Post or schedule a composed thread. False when nothing went out. */
	private async send(
		result: ComposeResult,
		tagSource?: () => Promise<void>,
	): Promise<boolean> {
		if (result.postAt != null) {
			return this.schedule(result.content, result.postAt);
		}

		const client = await this.clientForAccount(result.accountId);
		if (!client) return false;

		let posted: PostedTweet[];
		let sent = true;
		try {
			posted = await client.postThread(result.content);
		} catch (error) {
			// Keep the whole draft open; the posted list shows what went live.
			posted = error instanceof ThreadPostError ? error.posted : [];
			sent = false;
			playSound("failed");
			log.error(
				posted.length > 0
					? `Posted ${posted.length} of ${result.content.length}, the rest failed: ${errorMessage(error)}`
					: `Failed to post tweet: ${errorMessage(error)}`,
			);
		}
		this.showPosted(posted, client, tagSource).catch((error: unknown) =>
			log.error(`Posted, but could not finish up: ${errorMessage(error)}`),
		);
		return sent;
	}

	private async postSelection(editor: Editor): Promise<void> {
		if (!editor.somethingSelected()) {
			log.warning("Nothing is selected.");
			return;
		}
		const client = await this.clientForAccount(this.settings.defaultAccountId);
		if (!client) return;

		try {
			const posted = await this.withPosting(1, () =>
				client.postTweet(editor.getSelection()),
			);
			await this.showPosted([posted], client);
		} catch (error) {
			playSound("failed");
			log.error(`Failed to post tweet: ${errorMessage(error)}`);
		}
	}

	private async postFileAsThread(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			log.warning("Open a Markdown note first.");
			return;
		}

		let thread: string[];
		try {
			thread = parseThread(await this.app.vault.read(file));
		} catch (error) {
			log.warning(`Could not parse a thread in ${file.name}: ${errorMessage(error)}`);
			return;
		}

		const client = await this.clientForAccount(this.settings.defaultAccountId);
		if (!client) return;
		try {
			await this.showPosted(
				await this.withPosting(thread.length, () => client.postThread(thread)),
				client,
			);
		} catch (error) {
			playSound("failed");
			log.error(`Failed to post thread: ${errorMessage(error)}`);
		}
	}

	/**
	 * Bring the block under the cursor (a list item with its children, or the
	 * paragraph) into the composer, with its embedded images attached. Once
	 * posted, the tweet tag goes at the end of the block's first line.
	 */
	private async postCurrentBlock(editor: Editor, file: TFile | null): Promise<void> {
		const block = blockAtCursor(editor);
		if (!block) {
			log.warning("Put the cursor in a paragraph or a list item first.");
			return;
		}
		const attachments = block.images
			.map((link) => this.app.metadataCache.getFirstLinkpathDest(link, file?.path ?? ""))
			.filter(
				(image): image is TFile =>
					image !== null && IMAGE_EXTENSIONS[image.extension.toLowerCase()] === true,
			)
			.slice(0, MAX_MEDIA);
		await this.composeAndPost(
			{ initialText: block.text, initialAttachments: attachments },
			file ? () => this.tagBlock(file, block.firstLine) : undefined,
		);
	}

	private async tagBlock(file: TFile, firstLine: string): Promise<void> {
		const tag = this.settings.postTweetTag;
		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const index = lines.indexOf(firstLine);
			if (index === -1 || lines[index].includes(tag)) return data;
			// Keep a trailing block id (^abc) last, where Obsidian expects it.
			const blockId = /\s\^[\w-]+\s*$/.exec(lines[index])?.[0] ?? "";
			lines[index] = `${lines[index].slice(0, lines[index].length - blockId.length).trimEnd()} ${tag}${blockId}`;
			return lines.join("\n");
		});
	}

	/**
	 * Turn the active note into an X Article (X Premium): its `title` property,
	 * leading `# heading`, or file name becomes the title, its `cover` property
	 * the cover image. Saved as a draft first, then published unless the user
	 * chose to finish it in X's editor.
	 */
	private async postNoteAsArticle(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			log.warning("Open a Markdown note first.");
			return;
		}
		const frontmatter: Record<string, unknown> =
			this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const property = (key: string) => {
			const value = frontmatter[key];
			return typeof value === "string" ? value : undefined;
		};
		const source = {
			markdown: await this.app.vault.cachedRead(file),
			fallbackTitle: file.basename,
			title: property("title"),
			cover: property("cover"),
		};

		const choice = await ArticleModal.ask(
			this.app,
			articleTitle(source),
			this.settings.accounts,
			this.settings.defaultAccountId,
		);
		if (!choice) return;
		const client = await this.clientForAccount(choice.accountId);
		if (!client) return;

		playSound("send");
		try {
			const result = await this.withPosting(1, async () => {
				const draft = await noteToArticle(source, (link) =>
					client.uploadArticleImage(link, file.path),
				);
				draft.title = choice.title;
				return client.postArticle(draft, choice.draftOnly);
			});
			playSound("posted");
			const link = result.postId
				? { text: "Open the Article", href: `https://x.com/i/status/${result.postId}` }
				: {
						text: "Finish it in X",
						href: `https://x.com/compose/articles/edit/${result.articleId}`,
					};
			new Notice(
				createFragment((frag) => {
					const row = frag.createDiv({ cls: "nt-posting" });
					icon(row, "check");
					row.createSpan({
						text: result.postId ? "Article published. " : "Article draft saved. ",
					});
					row.createEl("a", { text: link.text, href: link.href });
				}),
				10_000,
			);
		} catch (error) {
			playSound("failed");
			log.error(`Failed to post the Article: ${errorMessage(error)}`);
		}
	}

	/** Show a spinner notice while `work` posts, then take it down. */
	private async withPosting<T>(count: number, work: () => Promise<T>): Promise<T> {
		const notice = new Notice(
			createFragment((frag) => {
				const row = frag.createDiv({ cls: "nt-posting" });
				icon(row, "loader");
				row.createSpan({ text: count > 1 ? `Posting ${count} posts\u2026` : "Posting\u2026" });
			}),
			0,
		);
		try {
			return await work();
		} finally {
			notice.hide();
		}
	}

	private async schedule(content: string[], postAt: number): Promise<boolean> {
		this.refreshScheduler();
		if (!this.scheduler) {
			new Notice("Set a scheduler URL in settings first.");
			return false;
		}

		const tweet: ScheduledTweet = {
			id: crypto.randomUUID(),
			content,
			postat: postAt,
		};
		try {
			await this.scheduler.scheduleTweet(tweet);
			return true;
		} catch (error) {
			log.error(`Failed to schedule tweet: ${errorMessage(error)}`);
			return false;
		}
	}

	private async clientForAccount(
		accountId: string | undefined,
	): Promise<TwitterClient | null> {
		if (!accountId) {
			new Notice("Thread Studio: add an X account in settings first.");
			return null;
		}
		const client = await this.connectAccount(accountId);
		if (client.isConnected) return client;
		new Notice(
			"Thread Studio: that X account is not connected. Check its credentials in settings.",
		);
		return null;
	}

	private async showPosted(
		posts: PostedTweet[],
		client: TwitterClient,
		tagSource?: () => Promise<void>,
	): Promise<void> {
		if (posts.length === 0) return;

		const modal = new TweetsPostedModal(this.app, posts, client);
		modal.open();
		await modal.waitForClose;

		if (modal.userDeletedTweets || !this.settings.postTweetTag) return;
		if (tagSource) {
			await tagSource();
			return;
		}
		for (const post of posts) await this.appendTweetTag(post.data.text);
	}

	private async appendTweetTag(text: string): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const trimmed = text.trim();
		await this.app.vault.process(file, (data) =>
			data.replace(trimmed, `${trimmed} ${this.settings.postTweetTag}`),
		);
	}
}
