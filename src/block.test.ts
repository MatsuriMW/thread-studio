import { describe, expect, it } from "vitest";
import { blockAtCursor, type BlockSource } from "./block";

function editorAt(text: string, line: number): BlockSource {
	const lines = text.split("\n");
	return {
		getCursor: () => ({ line, ch: 0 }),
		getLine: (n: number) => lines[n],
		lineCount: () => lines.length,
	} as BlockSource;
}

describe("blockAtCursor", () => {
	it("takes a list item with its children and flattens the markers", () => {
		const note = [
			"- before",
			"- TODO Ship **Thread Studio** [[Plans/Launch|launch]] %%private%%",
			"\t- first [docs](https://example.com)",
			"\t\t1. nested",
			"- after",
		].join("\n");

		expect(blockAtCursor(editorAt(note, 1))).toEqual({
			text: "Ship Thread Studio launch\n- first docs https://example.com\n1. nested",
			images: [],
			firstLine: "- TODO Ship **Thread Studio** [[Plans/Launch|launch]] %%private%%",
		});
	});

	it("takes the paragraph around the cursor outside lists", () => {
		const note = "Intro line\n\n## A heading\nsecond line ^abc123\n\nOther";
		expect(blockAtCursor(editorAt(note, 3))?.text).toBe("A heading\nsecond line");
	});

	it("moves embedded images out of the text", () => {
		const note = "- Look ![[shots/one.png|300]] at [[Daily/2026_10_25]]";
		expect(blockAtCursor(editorAt(note, 0))).toMatchObject({
			text: "Look  at 2026_10_25",
			images: ["shots/one.png"],
		});
	});

	it("returns null on a blank line", () => {
		expect(blockAtCursor(editorAt("text\n\nmore", 1))).toBeNull();
	});

	it("takes only the child item when the cursor is on it", () => {
		const note = "- parent\n\t- child\n\t\t- grandchild\n\t- sibling";
		expect(blockAtCursor(editorAt(note, 1))?.text).toBe("child\n- grandchild");
	});
});
