import type { Editor } from "obsidian";

/** The part of the editor that block extraction reads. */
export type BlockSource = Pick<Editor, "getCursor" | "getLine" | "lineCount">;

export interface CursorBlock {
	/** Post text: markers stripped, links and formatting flattened. */
	text: string;
	/** Link targets of embedded images (`![[x.png]]`), in order. */
	images: string[];
	/** The block's first line exactly as written, used to tag it once posted. */
	firstLine: string;
}

const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
/** Task keywords used by Logseq-style and TODOseq-style task lists. */
const KEYWORD =
	/^(?:TODO|DOING|DONE|LATER|NOW|IN-PROGRESS|WAITING|WAIT|PAUSED|SUSPENDED|CANCELLED|CANCELED|FAILED|TOREVIEW|NEEDOK|ERRORED|HITLIMIT|QUEUED|DELEGATED)\s+/;

function indentOf(line: string): number {
	return (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
}

/**
 * The block under the cursor. In a list it is that item with all of its
 * children; elsewhere it is the paragraph (the run of non-blank lines).
 * Returns `null` on a blank line or when the block has nothing to post.
 */
export function blockAtCursor(editor: BlockSource): CursorBlock | null {
	const at = editor.getCursor().line;
	const line = (n: number) => editor.getLine(n);
	const blank = (n: number) => line(n).trim() === "";
	if (blank(at)) return null;

	let start = -1;
	for (let n = at; n >= 0 && !blank(n); n--) {
		if (ITEM.test(line(n)) && (n === at || indentOf(line(n)) < indentOf(line(at)))) {
			start = n;
			break;
		}
	}

	let end: number;
	if (start >= 0) {
		const base = indentOf(line(start));
		end = start;
		while (end + 1 < editor.lineCount() && !blank(end + 1) && indentOf(line(end + 1)) > base) {
			end++;
		}
	} else {
		start = end = at;
		while (start > 0 && !blank(start - 1) && !ITEM.test(line(start - 1))) start--;
		while (end + 1 < editor.lineCount() && !blank(end + 1) && !ITEM.test(line(end + 1))) {
			end++;
		}
	}

	const raw: string[] = [];
	for (let n = start; n <= end; n++) raw.push(line(n));
	const images: string[] = [];
	const text = raw
		.map((source, index) => {
			const [, marker = "", body = ""] =
				/^((?:[-*+]|\d+[.)])\s+)?(?:\[.\]\s+)?(.*)$/.exec(source.trim()) ?? [];
			const cleaned = flattenMarkdown(
				body.replace(/^#{1,6}\s+/, "").replace(KEYWORD, ""),
				images,
			);
			if (!cleaned) return null;
			// The first line is the post's lead; child items keep a plain marker.
			return index === 0 ? cleaned : marker.replace(/^[*+]/, "-") + cleaned;
		})
		.filter((value): value is string => value !== null)
		.join("\n");

	if (!text && images.length === 0) return null;
	return { text, images, firstLine: raw[0] };
}

/**
 * Obsidian Markdown to post text: embedded images move to `images`, wikilinks
 * keep their alias or file name, `[text](url)` becomes `text url`, and
 * emphasis marks, `%%comments%%`, and block ids disappear.
 */
function flattenMarkdown(body: string, images: string[]): string {
	return body
		.replace(/!\[\[([^\]|#]+)[^\]]*]]/g, (_, link: string) => {
			images.push(link);
			return "";
		})
		.replace(/\[\[[^\]|]+\|([^\]]+)]]/g, "$1")
		.replace(/\[\[([^\]#]+)(?:#[^\]]*)?]]/g, (_, link: string) => link.split("/").pop() ?? link)
		.replace(/\[([^\]]+)]\((https?:[^)\s]+)\)/g, "$1 $2")
		.replace(/%%.*?%%/g, "")
		.replace(/\*\*|__|==|~~/g, "")
		.replace(/\s\^[\w-]+\s*$/, "")
		.trim();
}
