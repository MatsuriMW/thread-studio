import { type App, Modal, Setting } from "obsidian";
import { deferred } from "../deferred";
import type { XAccount } from "../settings";

export interface ArticleChoice {
	title: string;
	accountId: string;
	/** Save to X's drafts instead of publishing, to finish it in X's editor. */
	draftOnly: boolean;
}

/**
 * Confirms an Article before it goes to X: its title, the account, and
 * whether to publish now or save a draft. Resolves `null` when dismissed.
 */
export class ArticleModal extends Modal {
	private choice: ArticleChoice | null = null;

	static ask(
		app: App,
		title: string,
		accounts: XAccount[],
		accountId: string,
	): Promise<ArticleChoice | null> {
		const { promise, resolve } = deferred<ArticleChoice | null>();
		new ArticleModal(app, title, accounts, accountId, resolve).open();
		return promise;
	}

	private constructor(
		app: App,
		private title: string,
		private readonly accounts: XAccount[],
		private accountId: string,
		private readonly resolve: (choice: ArticleChoice | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("nt-article-modal");
		this.setTitle("Post note as X Article");
		this.contentEl.createEl("p", {
			cls: "nt-article-note",
			text: "Headings, lists, quotes, bold, italic, strikethrough, links, images, code blocks, tables, and dividers carry over. Articles need X Premium.",
		});

		new Setting(this.contentEl).setName("Title").addText((text) => {
			text.setValue(this.title).onChange((value) => {
				this.title = value;
			});
			text.inputEl.addClass("nt-article-title");
		});
		if (this.accounts.length > 1) {
			new Setting(this.contentEl).setName("Post from").addDropdown((dropdown) =>
				dropdown
					.addOptions(Object.fromEntries(this.accounts.map(({ id, name }) => [id, name])))
					.setValue(this.accountId)
					.onChange((value) => {
						this.accountId = value;
					}),
			);
		}

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Save draft").onClick(() => this.finish(true)),
			)
			.addButton((button) =>
				button.setButtonText("Publish").setCta().onClick(() => this.finish(false)),
			);
	}

	private finish(draftOnly: boolean): void {
		const title = this.title.trim();
		if (!title) return;
		this.choice = { title, accountId: this.accountId, draftOnly };
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.choice);
	}
}
