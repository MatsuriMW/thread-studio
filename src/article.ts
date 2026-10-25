/**
 * Obsidian Markdown to an X Article draft (`POST /2/articles/draft`).
 *
 * X stores an Article body as a DraftJS content state: a flat list of blocks
 * (paragraphs, three heading levels, list items, quotes) with inline style
 * ranges, plus entities for links and for atomic blocks (images, dividers, and
 * code blocks or tables, which X renders from Markdown). Offsets count Unicode
 * code points, as DraftJS raw content does.
 */

export type ArticleBlockType =
	| "unstyled"
	| "header-one"
	| "header-two"
	| "header-three"
	| "unordered-list-item"
	| "ordered-list-item"
	| "blockquote"
	| "atomic";

export type ArticleStyle = "bold" | "italic" | "strikethrough";

export interface ArticleBlock {
	text: string;
	type: ArticleBlockType;
	inline_style_ranges?: { offset: number; length: number; style: ArticleStyle }[];
	entity_ranges?: { key: number; offset: number; length: number }[];
}

export interface ArticleEntity {
	key: string;
	value: {
		type: "link" | "image" | "markdown" | "divider";
		mutability: "mutable" | "immutable";
		data: { url?: string; markdown?: string; media_items?: ArticleMedia[] };
	};
}

export interface ArticleMedia {
	media_id: string;
	media_category: string;
}

export interface ArticleDraft {
	title: string;
	content_state: { blocks: ArticleBlock[]; entities: ArticleEntity[] };
	cover_media?: ArticleMedia;
}

/** Uploads one vault image by link text; `null` skips it. */
export type ImageUploader = (link: string) => Promise<ArticleMedia | null>;

export interface ArticleSource {
	/** The note's full text, frontmatter included. */
	markdown: string;
	/** Title used when the note has no `title` property and no leading `# heading`. */
	fallbackTitle: string;
	/** The note's `title` property, if any. */
	title?: string;
	/** The note's `cover` property (an image link), if any. */
	cover?: string;
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
const FENCE = /^\s*(`{3,}|~{3,})/;
const DIVIDER = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^\s*(?:([-*+])|\d+[.)])\s+(?:\[.\]\s+)?(.*)$/;
const QUOTE = /^\s*>/;

/** The Article title: the `title` property, a leading `# heading`, or the fallback. */
export function articleTitle(source: ArticleSource): string {
	return splitTitle(source).title;
}

/** The title and the body lines left once a leading `# heading` became the title. */
function splitTitle(source: ArticleSource): { title: string; lines: string[] } {
	const lines = articleBody(source.markdown).split("\n");
	const title = source.title?.trim();
	if (title) return { title, lines };
	const first = lines.findIndex((line) => line.trim() !== "");
	const heading = first >= 0 ? /^#\s+(.*?)\s*$/.exec(lines[first]) : null;
	if (!heading) return { title: source.fallbackTitle, lines };
	lines.splice(first, 1);
	return { title: heading[1], lines };
}

/** Build the draft. Images are uploaded in document order as they are met. */
export async function noteToArticle(
	source: ArticleSource,
	uploadImage: ImageUploader,
): Promise<ArticleDraft> {
	const { title, lines } = splitTitle(source);
	const builder = new ArticleBuilder(uploadImage);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = FENCE.exec(line);
		if (fence) {
			const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
			let end = i + 1;
			while (end < lines.length && !close.test(lines[end])) end++;
			builder.markdown(lines.slice(i, end + 1).join("\n"));
			i = end;
			continue;
		}
		if (/^\s*\|/.test(line)) {
			let end = i;
			while (end + 1 < lines.length && /^\s*\|/.test(lines[end + 1])) end++;
			builder.markdown(lines.slice(i, end + 1).join("\n"));
			i = end;
			continue;
		}
		if (line.trim() === "") continue;
		if (DIVIDER.test(line)) {
			builder.divider();
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			const type = level === 1 ? "header-one" : level === 2 ? "header-two" : "header-three";
			await builder.text(type, heading[2]);
			continue;
		}
		const item = LIST_ITEM.exec(line);
		if (item) {
			await builder.text(item[1] ? "unordered-list-item" : "ordered-list-item", item[2]);
			continue;
		}
		if (QUOTE.test(line)) {
			const quote = line.replace(/^\s*(?:>\s?)+/, "").replace(/^\[!\w+][+-]?\s*/, "");
			await builder.text("blockquote", quote);
			continue;
		}
		await builder.text("unstyled", line.trim());
	}

	const draft: ArticleDraft = {
		title,
		content_state: { blocks: builder.blocks, entities: builder.entities },
	};
	const cover = source.cover && embeddedLink(source.cover);
	if (cover) {
		const media = await uploadImage(cover);
		if (media) draft.cover_media = media;
	}
	return draft;
}

/** The note without frontmatter, `%% comments %%`, and HTML comments. */
function articleBody(markdown: string): string {
	return markdown
		.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
		.replace(/\r\n?/g, "\n")
		.replace(/%%[\s\S]*?%%/g, "")
		.replace(/<!--[\s\S]*?-->/g, "");
}

/** `[[a.png]]`, `![[a.png|300]]`, `![](a.png)` or a bare path, to `a.png`. */
function embeddedLink(value: string): string {
	const wiki = /\[\[([^\]|#]+)/.exec(value);
	if (wiki) return wiki[1].trim();
	const markdown = /\]\(([^)\s]+)\)/.exec(value);
	return (markdown ? decodeURI(markdown[1]) : value).trim();
}

class ArticleBuilder {
	readonly blocks: ArticleBlock[] = [];
	readonly entities: ArticleEntity[] = [];

	constructor(private readonly uploadImage: ImageUploader) {}

	/** A text block. Embedded images in it follow it as image blocks. */
	async text(type: ArticleBlockType, raw: string): Promise<void> {
		const images: string[] = [];
		const body = raw
			.replace(/!\[\[([^\]]+)]]/g, (_, inner: string) => {
				const link = inner.split("|")[0].trim();
				if (IMAGE_EXTENSION.test(link)) images.push(link);
				return "";
			})
			.replace(/!\[([^\]]*)]\(([^)\s]+)\)/g, (_, alt: string, src: string) => {
				if (/^https?:/i.test(src)) return alt ? `[${alt}](${src})` : src;
				images.push(decodeURI(src));
				return "";
			})
			.replace(/\s\^[\w-]+\s*$/, "")
			.trim();

		const inline = parseInline(body);
		if (inline.text.trim()) {
			const block: ArticleBlock = { text: inline.text, type };
			const at = codePointOffsets(inline.text);
			if (inline.styles.length) {
				block.inline_style_ranges = inline.styles.map(({ start, end, style }) => ({
					offset: at(start),
					length: at(end) - at(start),
					style,
				}));
			}
			if (inline.links.length) {
				block.entity_ranges = inline.links.map(({ start, end, url }) => ({
					key: this.entity({ type: "link", mutability: "mutable", data: { url } }),
					offset: at(start),
					length: at(end) - at(start),
				}));
			}
			this.blocks.push(block);
		}
		for (const link of images) await this.image(link);
	}

	async image(link: string): Promise<void> {
		const media = await this.uploadImage(link);
		if (media) {
			this.atomic({ type: "image", mutability: "immutable", data: { media_items: [media] } });
		}
	}

	divider(): void {
		this.atomic({ type: "divider", mutability: "immutable", data: {} });
	}

	/** A code block or table, which X renders from its Markdown. */
	markdown(markdown: string): void {
		this.atomic({ type: "markdown", mutability: "mutable", data: { markdown } });
	}

	private atomic(value: ArticleEntity["value"]): void {
		const key = this.entity(value);
		this.blocks.push({
			text: " ",
			type: "atomic",
			entity_ranges: [{ key, offset: 0, length: 1 }],
		});
	}

	private entity(value: ArticleEntity["value"]): number {
		this.entities.push({ key: String(this.entities.length), value });
		return this.entities.length - 1;
	}
}

interface Inline {
	text: string;
	/** UTF-16 ranges; converted to code points when the block is built. */
	styles: { start: number; end: number; style: ArticleStyle }[];
	links: { start: number; end: number; url: string }[];
}

const INLINE = new RegExp(
	[
		String.raw`(?<bold>\*\*|__)(?<boldText>.+?)\k<bold>`,
		String.raw`~~(?<strike>.+?)~~`,
		String.raw`==(?<mark>.+?)==`,
		String.raw`\*(?!\s)(?<starItalic>.+?)(?<!\s)\*`,
		String.raw`(?<![\p{L}\p{N}])_(?!\s)(?<lineItalic>.+?)(?<!\s)_(?![\p{L}\p{N}])`,
		String.raw`\[\[(?<wikiTarget>[^\]|]+)(?:\|(?<wikiAlias>[^\]]+))?\]\]`,
		String.raw`\[(?<label>[^\]]+)\]\((?<url>[^)\s]+)\)`,
		String.raw`\x60(?<code>[^\x60]+)\x60`,
		String.raw`(?<bare>https?:\/\/[^\s<>)\]]+)`,
	].join("|"),
	"u",
);

/** Flatten inline Markdown to text with style and link ranges. */
export function parseInline(source: string): Inline {
	const out: Inline = { text: "", styles: [], links: [] };
	walk(source, [], out);
	return out;
}

function walk(source: string, styles: ArticleStyle[], out: Inline): void {
	let rest = source;
	while (rest) {
		const match = INLINE.exec(rest);
		if (!match?.groups) {
			append(out, rest, styles);
			return;
		}
		append(out, rest.slice(0, match.index), styles);
		const g = match.groups;
		if (g.boldText !== undefined) walk(g.boldText, [...styles, "bold"], out);
		else if (g.strike !== undefined) walk(g.strike, [...styles, "strikethrough"], out);
		// X has no highlight; bold keeps the emphasis.
		else if (g.mark !== undefined) walk(g.mark, [...styles, "bold"], out);
		else if (g.starItalic !== undefined) walk(g.starItalic, [...styles, "italic"], out);
		else if (g.lineItalic !== undefined) walk(g.lineItalic, [...styles, "italic"], out);
		else if (g.wikiTarget !== undefined) {
			const name = g.wikiTarget.split("#")[0].split("/").pop() ?? g.wikiTarget;
			append(out, g.wikiAlias ?? name, styles);
		} else if (g.label !== undefined && g.url !== undefined) {
			const start = out.text.length;
			walk(g.label, styles, out);
			if (/^https?:/i.test(g.url)) out.links.push({ start, end: out.text.length, url: g.url });
		} else if (g.code !== undefined) append(out, g.code, styles);
		else if (g.bare !== undefined) {
			const start = out.text.length;
			append(out, g.bare, styles);
			out.links.push({ start, end: out.text.length, url: g.bare });
		}
		rest = rest.slice(match.index + match[0].length);
	}
}

function append(out: Inline, text: string, styles: ArticleStyle[]): void {
	if (!text) return;
	const start = out.text.length;
	out.text += text;
	for (const style of new Set(styles)) {
		out.styles.push({ start, end: out.text.length, style });
	}
}

/** Map UTF-16 indices in `text` to code point offsets. */
function codePointOffsets(text: string): (index: number) => number {
	const map: number[] = [];
	let points = 0;
	for (let i = 0; i < text.length; i++) {
		map[i] = points;
		const code = text.charCodeAt(i);
		if (!(code >= 0xd800 && code <= 0xdbff && i + 1 < text.length)) points++;
	}
	map[text.length] = points;
	return (index) => map[index];
}
