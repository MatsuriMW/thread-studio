import { type App, Modal, Notice, Setting } from "obsidian";
import { deferred } from "../deferred";
import type { PostedTweet } from "../xApi";
import type { TwitterClient } from "../twitter";
import { icon, playSound } from "../fx";

/**
 * Confirmation shown after posting. Links to each live tweet and offers to
 * delete the whole thread again. `waitForClose` resolves when dismissed, and
 * `userDeletedTweets` reports whether the user deleted them.
 */
export class TweetsPostedModal extends Modal {
	public userDeletedTweets = false;
	public readonly waitForClose: Promise<void>;
	private readonly resolveClose: () => void;

	constructor(
		app: App,
		private readonly posts: PostedTweet[],
		private readonly twitter: TwitterClient,
	) {
		super(app);
		const { promise, resolve } = deferred<void>();
		this.waitForClose = promise;
		this.resolveClose = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(
			this.posts.length > 1 ? "Your tweets are live!" : "Your tweet is live!",
		);

		this.modalEl.addClass("nt-posted-modal");
		playSound("posted");
		this.titleEl.prepend(icon(createFragment(), "check"));

		const list = contentEl.createDiv({ cls: "nt-posted-list" });
		this.posts.forEach((post, index) => {
			const item = list.createEl("a", {
				cls: "nt-posted-item",
				href: `https://x.com/i/status/${post.data.id}`,
				attr: { target: "_blank", rel: "noopener", "aria-label": "Open on X" },
			});
			item.setCssProps({ "--i": String(index) });
			item.createSpan({ cls: "nt-posted-text", text: post.data.text });
			icon(item, "open");
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Delete")
					.setDestructive()
					.onClick(() => this.deletePosted()),
			)
			.addButton((button) =>
				button
					.setButtonText("Great!")
					.setCta()
					.onClick(() => this.close()),
			);
	}

	private async deletePosted(): Promise<void> {
		const deleted = await this.twitter.deleteTweets(
			this.posts.map((post) => ({ id: post.data.id })),
		);

		if (!deleted) {
			new Notice("Could not delete tweet(s).");
			return;
		}

		this.userDeletedTweets = true;
		playSound("deleted");
		const plural = this.posts.length > 1 ? "s" : "";
		new Notice(`${this.posts.length} tweet${plural} deleted.`);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolveClose();
	}
}
