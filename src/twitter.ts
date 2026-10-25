import type { App } from "obsidian";
import type { ArticleDraft, ArticleMedia } from "./article";
import { log } from "./log";
import { hasCompleteCredentials, type TwitterCredentials } from "./secrets";
import {
	XApiClient,
	type HttpRequest,
	type PostedTweet,
	type TweetPayload,
} from "./xApi";

const IMAGE_REGEX =
	/!?\[\[([\w .\-/]*\.(gif|jpe?g|tiff?|png|webp|bmp))]]/i;

const MIME_BY_EXTENSION: Record<string, string> = {
	gif: "image/gif",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	tif: "image/tiff",
	tiff: "image/tiff",
	png: "image/png",
	webp: "image/webp",
	bmp: "image/bmp",
};

/** A thread that failed while posting. `posted` holds the tweets already live. */
export class ThreadPostError extends Error {
	constructor(
		readonly posted: PostedTweet[],
		error: unknown,
	) {
		super(
			error instanceof Error
				? error.message
				: typeof error === "string"
					? error
					: "Unknown error",
		);
	}
}

/** Thin wrapper around the X API client that owns the connection state. */
export class TwitterClient {
	private client: XApiClient | null = null;
	public isConnected = false;
	public lastError: string | null = null;

	constructor(
		private readonly app: App,
		private readonly request?: HttpRequest,
	) {}

	/**
	 * Connect and verify the credentials with a `me()` call. Any failure
	 * (bad credentials, an app not attached to a v2 Project, network) leaves the
	 * client disconnected and records the X-provided reason in {@link lastError}
	 * so the UI can show something actionable. NoteTweet uses the v2 API for
	 * posting too, so a forbidden v2 check means posting would fail as well.
	 */
	async connect(credentials: TwitterCredentials): Promise<boolean> {
		if (!hasCompleteCredentials(credentials)) {
			this.client = null;
			this.isConnected = false;
			this.lastError = null;
			return false;
		}

		try {
			this.client = new XApiClient(
				{
					consumerKey: credentials.apiKey,
					consumerSecret: credentials.apiSecret,
					accessToken: credentials.accessToken,
					accessTokenSecret: credentials.accessTokenSecret,
				},
				this.request,
			);
			await this.client.me();
			this.isConnected = true;
			this.lastError = null;
			return true;
		} catch (error) {
			this.client = null;
			this.isConnected = false;
			this.lastError =
				error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	async postThread(content: string[]): Promise<PostedTweet[]> {
		const client = this.requireClient();
		const payloads: TweetPayload[] = [];
		for (const text of content) {
			payloads.push(await this.buildTweet(text));
		}

		// Mirrors twitter-api-v2's tweetThread: post sequentially, chaining
		// each tweet as a reply to the previously posted one.
		const posted: PostedTweet[] = [];
		for (const payload of payloads) {
			const previous = posted[posted.length - 1];
			if (previous) {
				payload.reply = { in_reply_to_tweet_id: previous.data.id };
			}
			try {
				posted.push(await client.createTweet(payload));
			} catch (error) {
				throw new ThreadPostError(posted, error);
			}
		}
		return posted;
	}

	async postTweet(text: string): Promise<PostedTweet> {
		const client = this.requireClient();
		return client.createTweet(await this.buildTweet(text));
	}

	/**
	 * Upload an image linked from `sourcePath` for an Article. Warns and
	 * resolves `null` when the file is missing or the upload fails, so one bad
	 * image does not sink the whole Article.
	 */
	async uploadArticleImage(link: string, sourcePath: string): Promise<ArticleMedia | null> {
		const client = this.requireClient();
		const file = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
		const mimeType = file && MIME_BY_EXTENSION[file.extension.toLowerCase()];
		if (!file || !mimeType) {
			log.warning(`Could not find image '${link}' in the vault.`);
			return null;
		}
		try {
			const mediaId = await client.uploadMedia(await this.app.vault.readBinary(file), mimeType);
			return {
				media_id: mediaId,
				media_category: mimeType === "image/gif" ? "tweet_gif" : "tweet_image",
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : "upload failed";
			log.warning(`Could not upload image '${link}': ${reason}`);
			return null;
		}
	}

	/**
	 * Save an Article draft, and publish it unless `draftOnly`. Resolves to the
	 * draft id and, once published, the id of the post that carries it.
	 */
	async postArticle(
		draft: ArticleDraft,
		draftOnly: boolean,
	): Promise<{ articleId: string; postId: string | null }> {
		const client = this.requireClient();
		const articleId = await client.createArticleDraft(draft);
		if (draftOnly) return { articleId, postId: null };
		return { articleId, postId: await client.publishArticle(articleId) };
	}

	async deleteTweets(tweets: { id: string }[]): Promise<boolean> {
		const client = this.requireClient();
		try {
			for (const tweet of tweets) {
				await client.deleteTweet(tweet.id);
			}
			return true;
		} catch (error) {
			log.error(`Could not delete tweets: ${error}`);
			return false;
		}
	}

	private requireClient(): XApiClient {
		if (!this.client) throw new Error("Not connected to Twitter.");
		return this.client;
	}

	/** Resolve embedded image links to uploaded media and strip them from text. */
	private async buildTweet(text: string): Promise<TweetPayload> {
		const client = this.requireClient();
		const mediaIds: string[] = [];
		let body = text;

		let match: RegExpExecArray | null;
		while ((match = IMAGE_REGEX.exec(body)) !== null) {
			const fileName = match[1];
			body = body.replace(IMAGE_REGEX, "").trim();

			const file = this.app.metadataCache.getFirstLinkpathDest(fileName, "");
			if (!file) {
				log.warning(`Could not find image '${fileName}' in the vault.`);
				continue;
			}

			const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
			const mimeType = MIME_BY_EXTENSION[extension];
			const data = await this.app.vault.readBinary(file);
			try {
				mediaIds.push(await client.uploadMedia(data, mimeType));
			} catch {
				log.warning(`Could not upload image '${fileName}' to Twitter.`);
			}
		}

		if (mediaIds.length === 0) return { text: body };
		return { text: body, media: { media_ids: mediaIds } };
	}
}
