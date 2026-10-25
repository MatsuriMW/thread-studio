import { describe, expect, it } from "vitest";
import { articleTitle, noteToArticle, parseInline, type ArticleMedia } from "./article";

const noImages = () => Promise.resolve(null);

describe("articleTitle", () => {
	it("prefers the title property, then a leading heading, then the fallback", () => {
		const markdown = "---\ntags: [a]\n---\n\n# From heading\nBody";
		expect(articleTitle({ markdown, fallbackTitle: "file", title: "From property" })).toBe(
			"From property",
		);
		expect(articleTitle({ markdown, fallbackTitle: "file" })).toBe("From heading");
		expect(articleTitle({ markdown: "Body only", fallbackTitle: "file" })).toBe("file");
	});
});

describe("parseInline", () => {
	it("flattens emphasis, wikilinks, and code into styled ranges", () => {
		const inline = parseInline("A **bold _both_** ~~gone~~ ==mark== [[Note|alias]] `x`");
		expect(inline.text).toBe("A bold both gone mark alias x");
		expect(inline.styles).toEqual([
			{ start: 2, end: 7, style: "bold" },
			{ start: 7, end: 11, style: "bold" },
			{ start: 7, end: 11, style: "italic" },
			{ start: 12, end: 16, style: "strikethrough" },
			{ start: 17, end: 21, style: "bold" },
		]);
	});

	it("keeps snake_case words plain", () => {
		expect(parseInline("a snake_case_name here").styles).toEqual([]);
	});

	it("links Markdown links and bare URLs, but not internal links", () => {
		const inline = parseInline("[site](https://x.com) and https://a.dev/p and [note](Other.md)");
		expect(inline.text).toBe("site and https://a.dev/p and note");
		expect(inline.links).toEqual([
			{ start: 0, end: 4, url: "https://x.com" },
			{ start: 9, end: 24, url: "https://a.dev/p" },
		]);
	});
});

describe("noteToArticle", () => {
	it("maps Markdown blocks to Article blocks and entities", async () => {
		const markdown = [
			"---",
			"cover: \"[[cover.png]]\"",
			"---",
			"# Launch notes",
			"",
			"Intro with a [link](https://example.com). ^id1",
			"%% hidden %%",
			"## Why",
			"### Details",
			"- one",
			"1. two",
			"> [!note] Remember",
			"---",
			"```ts",
			"const a = 1;",
			"```",
			"| a | b |",
			"|---|---|",
			"Look ![[shot.png]] here",
		].join("\n");
		const uploaded: string[] = [];
		const upload = (link: string): Promise<ArticleMedia> => {
			uploaded.push(link);
			return Promise.resolve({ media_id: `m-${link}`, media_category: "tweet_image" });
		};

		const draft = await noteToArticle(
			{ markdown, fallbackTitle: "file", cover: "[[cover.png]]" },
			upload,
		);

		expect(draft.title).toBe("Launch notes");
		expect(draft.cover_media).toEqual({ media_id: "m-cover.png", media_category: "tweet_image" });
		expect(uploaded).toEqual(["shot.png", "cover.png"]);
		expect(draft.content_state.blocks.map((block) => [block.type, block.text])).toEqual([
			["unstyled", "Intro with a link."],
			["header-two", "Why"],
			["header-three", "Details"],
			["unordered-list-item", "one"],
			["ordered-list-item", "two"],
			["blockquote", "Remember"],
			["atomic", " "],
			["atomic", " "],
			["atomic", " "],
			["unstyled", "Look  here"],
			["atomic", " "],
		]);
		expect(draft.content_state.entities.map(({ key, value }) => [key, value.type])).toEqual([
			["0", "link"],
			["1", "divider"],
			["2", "markdown"],
			["3", "markdown"],
			["4", "image"],
		]);
		expect(draft.content_state.blocks[0].entity_ranges).toEqual([
			{ key: 0, offset: 13, length: 4 },
		]);
		expect(draft.content_state.entities[2].value.data.markdown).toBe("```ts\nconst a = 1;\n```");
	});

	it("counts offsets in code points and skips images that fail to upload", async () => {
		const draft = await noteToArticle(
			{ markdown: "😀 **hi**\n![[gone.png]]", fallbackTitle: "file" },
			noImages,
		);
		expect(draft.content_state.blocks).toEqual([
			{
				text: "😀 hi",
				type: "unstyled",
				inline_style_ranges: [{ offset: 2, length: 2, style: "bold" }],
			},
		]);
		expect(draft.content_state.entities).toEqual([]);
	});
});
