/**
 * Composer polish: animated icons, layout motion, and UI sounds.
 *
 * Icons are Lucide (ISC, the set Obsidian ships) rebuilt with named parts so
 * CSS can animate them on hover, following lucide-animated
 * (github.com/pqoqubbw/icons): arrows nudge, the bin lid lifts, the plane takes
 * off, the clock hand sweeps, the check draws itself. Sounds are synthesized
 * with Web Audio, so the plugin ships no audio files.
 */

type SvgNode = [tag: keyof SVGElementTagNameMap, attr: Record<string, string>, children?: SvgNode[]];

const path = (d: string, cls?: string): SvgNode => ["path", cls ? { d, class: cls } : { d }];
const group = (cls: string, ...children: SvgNode[]): SvgNode => ["g", { class: cls }, children];

const ICONS = {
	image: [
		["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
		["circle", { class: "sun", cx: "9", cy: "9", r: "2" }],
		path("m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21", "hill"),
	],
	"arrow-up": [group("nudge-up", path("m5 12 7-7 7 7"), path("M12 19V5"))],
	"arrow-down": [group("nudge-down", path("M12 5v14"), path("m19 12-7 7-7-7"))],
	trash: [
		group("lid", path("M3 6h18"), path("M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2")),
		path("M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"),
		["line", { x1: "10", x2: "10", y1: "11", y2: "17" }],
		["line", { x1: "14", x2: "14", y1: "11", y2: "17" }],
	],
	plus: [group("turn", path("M5 12h14"), path("M12 5v14"))],
	send: [
		group(
			"fly",
			path("M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"),
			path("m21.854 2.147-10.94 10.939"),
		),
	],
	clock: [["circle", { cx: "12", cy: "12", r: "10" }], path("M12 6v6l4 2", "hand")],
	x: [group("turn", path("M18 6 6 18"), path("m6 6 12 12"))],
	check: [
		["circle", { class: "draw", pathLength: "1", cx: "12", cy: "12", r: "10" }],
		["path", { class: "draw late", pathLength: "1", d: "m9 12 2 2 4-4" }],
	],
	open: [group("nudge-out", path("M7 7h10v10"), path("M7 17 17 7"))],
	loader: [path("M21 12a9 9 0 1 1-6.219-8.56", "spin")],
	reply: [path("M7.9 20A9 9 0 1 0 4 16.1L2 22Z")],
	repost: [
		group(
			"turn",
			path("m2 9 3-3 3 3"),
			path("M13 18H7a2 2 0 0 1-2-2V6"),
			path("m22 15-3 3-3-3"),
			path("M11 6h6a2 2 0 0 1 2 2v10"),
		),
	],
	like: [
		path(
			"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
			"beat",
		),
	],
	views: [path("M6 20v-6", "bar b1"), path("M12 20V4", "bar b2"), path("M18 20V10", "bar b3")],
} satisfies Record<string, SvgNode[]>;

export type IconName = keyof typeof ICONS;

/** Append an animated icon to `parent` and return its wrapper span. */
export function icon(parent: Node, name: IconName): HTMLElement {
	const el = parent.createSpan({
		cls: `nt-ico nt-ico-${name}`,
		attr: { "aria-hidden": "true" },
	});
	const svg = el.createSvg("svg", {
		attr: {
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "2",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
		},
	});
	buildSvg(svg, ICONS[name]);
	return el;
}

function buildSvg(parent: SVGElement, nodes: SvgNode[]): void {
	for (const [tag, attr, children] of nodes) {
		const el = parent.createSvg(tag, { attr });
		if (children) buildSvg(el, children);
	}
}

/** False when the user asked the OS for reduced motion. */
export function motionAllowed(): boolean {
	return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
export const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
export const ENTER: Keyframe[] = [
	{ opacity: 0, transform: "translateY(10px) scale(0.98)" },
	{ opacity: 1, transform: "none" },
];
export const SHAKE: Keyframe[] = [
	{ transform: "none" },
	{ transform: "translateX(-4px)" },
	{ transform: "translateX(4px)" },
	{ transform: "translateX(-2px)" },
	{ transform: "translateX(1px)" },
	{ transform: "none" },
];

interface Sound {
	type: OscillatorType;
	/** [frequency in Hz, duration in seconds] per note. */
	notes: [number, number][];
	vol?: number;
	attack?: number;
}

/**
 * Short, quiet, low-register cues: moving forward goes up, undoing goes down.
 */
const SOUNDS = {
	add: { type: "triangle", notes: [[523, 0.05], [659, 0.08]] },
	remove: { type: "triangle", notes: [[440, 0.05], [349, 0.1]] },
	move: { type: "triangle", notes: [[587, 0.05]] },
	split: { type: "triangle", notes: [[494, 0.04], [587, 0.04], [698, 0.08]], vol: 0.8 },
	attach: { type: "sine", notes: [[587, 0.05], [784, 0.09]] },
	detach: { type: "sine", notes: [[523, 0.05], [392, 0.09]] },
	over: { type: "triangle", notes: [[220, 0.08], [175, 0.14]], vol: 1.2 },
	mode: { type: "sine", notes: [[659, 0.04]], vol: 0.7 },
	toggle: { type: "triangle", notes: [[523, 0.05]] },
	send: { type: "sine", notes: [[392, 0.04], [523, 0.05], [698, 0.1]], vol: 0.8 },
	schedule: { type: "sine", notes: [[440, 0.07], [440, 0.1]] },
	posted: { type: "sine", notes: [[392, 0.09], [523, 0.22]], vol: 0.85, attack: 0.03 },
	failed: { type: "triangle", notes: [[196, 0.1], [147, 0.2]], vol: 1.2 },
	deleted: { type: "triangle", notes: [[330, 0.08], [247, 0.16]] },
} satisfies Record<string, Sound>;

export type SoundName = keyof typeof SOUNDS;

const VOLUME = 0.1;
let soundOn = true;
let audio: AudioContext | null = null;

export function setSoundEnabled(on: boolean): void {
	soundOn = on;
}

export function playSound(name: SoundName): void {
	if (!soundOn) return;
	const spec: Sound = SOUNDS[name];
	try {
		audio ??= new AudioContext();
		if (audio.state === "suspended") void audio.resume();
		let at = audio.currentTime;
		const volume = VOLUME * (spec.vol ?? 1);
		for (const [frequency, duration] of spec.notes) {
			const osc = audio.createOscillator();
			const gain = audio.createGain();
			osc.type = spec.type;
			osc.frequency.setValueAtTime(frequency, at);
			gain.gain.setValueAtTime(0, at);
			gain.gain.linearRampToValueAtTime(volume, at + (spec.attack ?? 0.012));
			gain.gain.exponentialRampToValueAtTime(1e-4, at + duration);
			osc.connect(gain).connect(audio.destination);
			osc.start(at);
			osc.stop(at + duration + 0.02);
			at += duration * 0.85;
		}
	} catch {
		// Sound is decoration; a missing or blocked audio device is not an error.
	}
}
