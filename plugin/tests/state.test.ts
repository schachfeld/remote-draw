import assert from "node:assert/strict";
import { it } from "node:test";
import { exportBounds, exportRaster, referenceBounds, referenceOnSheet, sheetOrigin, toWorld, viewOrigin } from "../src/geometry.ts";
import { linkLine, type Status } from "../src/link-status.ts";
import { Sheets, inkSignature, type IncomingInk, type PublishReason } from "../src/state.ts";
import { PNG } from "./helpers.ts";

const OTHER_PNG = PNG.replace("AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
const image = (png = PNG, x = 1900) => ({ x, y: 600, width: 200, height: 80, png });
function setup(kind: "teaching" | "practice" = "teaching") {
  const reasons: PublishReason[] = [], problems: string[] = [];
  const sheets = new Sheets("window-test", reason => reasons.push(reason), state => problems.push(state.id));
  const state = sheets.session("s1", kind);
  const create = () => sheets.create(state, { background: "data:image/png;base64," + PNG, backgroundColor: "rgb(0, 0, 0)", palette: "dark-a", theme: "dark", width: 670, height: 300, pixelRatio: 2 });
  const ink = (seq: number, extra: Partial<IncomingInk> = {}): IncomingInk => ({ sheet: state.draft!.sheetId, seq, theme: "dark", drawing: "AAEC", image: image(), ...extra });
  return { sheets, state, reasons, problems, create, ink };
}

it("maps the sheet to the window's world and back", () => {
  assert.deepEqual(sheetOrigin(300), { x: 2000, y: 350 });
  assert.deepEqual(sheetOrigin(0), { x: 2000, y: 2000 });
  assert.deepEqual(referenceOnSheet(670, 300), { x: 1665, y: 200, width: 670, height: 300 });
  // The question picture's place on the sheet is exactly its world rectangle.
  assert.deepEqual(toWorld(referenceOnSheet(670, 300), 300), referenceBounds(670, 300));
  assert.deepEqual(toWorld({ x: 2000, y: 2000, width: 10, height: 10, png: "x" }, 0), { x: 0, y: 0, width: 10, height: 10, png: "x" });
});
it("puts the question picture at the top centre and never scales", () => {
  for (const [width, height, referenceHeight] of [[800, 600, 200], [1200, 900, 200], [300, 200, 1000]] as const) {
    const origin = viewOrigin(width, height, { x: 0, y: 0 }, referenceHeight);
    assert.equal(origin.x, width / 2); assert.equal(origin.y - referenceHeight / 2, 64);
    assert.deepEqual(viewOrigin(width, height, { x: -40, y: 30 }, referenceHeight), { x: origin.x - 40, y: origin.y + 30 });
  }
  assert.deepEqual(viewOrigin(800, 600, { x: 0, y: 0 }), { x: 400, y: 300 });
});
it("exports the question and the ink together with a margin, within the size cap", () => {
  assert.deepEqual(exportBounds(670, 300, { x: -100, y: 200, width: 500, height: 100 }), { x: -359, y: -174, width: 783, height: 498 });
  assert.deepEqual(exportBounds(0, 0, { x: 10, y: 20, width: 30, height: 40 }), { x: -14, y: -4, width: 78, height: 88 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 1000, height: 600 }, 2, 50), { width: 1000, height: 600 });
  assert.deepEqual(exportRaster({ x: 0, y: 0, width: 3000, height: 2000 }, 2, 100), { width: 2000, height: 1333 });
  assert.throws(() => exportRaster({ x: 0, y: 0, width: 0, height: 1 }, 2, 50));
  assert.throws(() => exportRaster({ x: 0, y: 0, width: 1, height: 1 }, 2, 0));
});
it("names each new sheet uniquely for the wire", () => {
  const { sheets, state, create } = setup();
  const first = create().sheetId;
  sheets.dropUntouched(state);
  assert.equal(state.draft, undefined);
  const second = create().sheetId;
  assert.notEqual(first, second); assert.match(second, /^[A-Za-z0-9_-]{1,128}$/);
});
it("applies ink in order and treats an identical rendering as no edit", () => {
  const { sheets, state, reasons, create, ink } = setup();
  create(); reasons.length = 0;
  assert.equal(sheets.setInk(state, ink(2)), true);
  assert.equal(state.draft!.revision, 1); assert.deepEqual(reasons, ["ink"]);
  assert.equal(sheets.setInk(state, ink(1, { image: image(OTHER_PNG) })), false, "an older delivery is ignored");
  assert.equal(sheets.setInk(state, ink(2, { image: image(OTHER_PNG) })), false, "a repeated delivery is ignored");
  assert.equal(sheets.setInk(state, ink(3, { theme: "light" })), false, "the same picture again");
  assert.equal(state.draft!.revision, 1); assert.equal(state.draft!.ink!.theme, "light"); assert.equal(state.draft!.seq, 3);
  assert.equal(sheets.setInk(state, { ...ink(4), sheet: "another-sheet" }), false);
  assert.equal(sheets.setInk(state, ink(4, { image: image(PNG, 1901) })), true, "the same picture somewhere else is a change");
  assert.equal(sheets.setInk(state, ink(5, { image: undefined, drawing: undefined })), true);
  assert.equal(state.draft!.ink, undefined); assert.equal(state.draft!.revision, 3);
  assert.equal(sheets.setInk(state, ink(6, { image: undefined, drawing: undefined })), false, "empty again is no edit");
  assert.equal(state.draft!.revision, 3);
  assert.notEqual(inkSignature(image()), inkSignature(image(OTHER_PNG)));
});
it("teaching: sends while there is ink and clears after acceptance unless it changed", () => {
  const { sheets, state, create, ink } = setup();
  create();
  assert.equal(sheets.pending(state), false); assert.equal(sheets.capture(state)!.sendImage, false);
  sheets.setInk(state, ink(1));
  assert.equal(sheets.pending(state), true);
  const first = sheets.capture(state)!;
  assert.equal(first.sendImage, true);
  sheets.setInk(state, ink(2, { image: image(OTHER_PNG) }));
  assert.equal(sheets.accepted(first), false, "newer ink survives an older acceptance");
  assert.ok(state.draft!.ink);
  const second = sheets.capture(state)!;
  sheets.setInk(state, ink(3, { image: image(OTHER_PNG) })); // A re-rendering of the same picture during the attempt.
  assert.equal(sheets.accepted(second), true);
  assert.equal(state.draft!.ink, undefined); assert.equal(sheets.pending(state), false);
  sheets.dropUntouched(state);
  assert.equal(state.draft, undefined);
});
it("practice: keeps the board, resends only changes, resets on a new problem", () => {
  const { sheets, state, problems, create, ink } = setup("practice");
  assert.equal(sheets.observePoses(state, ["p1"], true), false);
  create(); sheets.setInk(state, ink(1));
  const first = sheets.capture(state)!;
  assert.equal(first.sendImage, true);
  assert.equal(sheets.accepted(first), false);
  assert.ok(state.draft!.ink, "the board is kept");
  assert.equal(sheets.pending(state), false); assert.equal(sheets.capture(state)!.sendImage, false);
  sheets.setInk(state, ink(2, { image: image(OTHER_PNG) }));
  assert.equal(sheets.pending(state), true);
  sheets.setInk(state, ink(3)); // Undo back to the picture that was sent.
  assert.equal(sheets.pending(state), false);
  assert.equal(sheets.observePoses(state, ["p1"]), false);
  assert.equal(sheets.observePoses(state, ["p1", "p2"]), true);
  assert.equal(state.draft, undefined); assert.deepEqual(problems, ["s1"]);
  // An acceptance for the old problem's sheet no longer applies.
  create();
  assert.equal(sheets.accepted(first), false); assert.equal(state.sentSignature, "");
});
it("re-rendered backgrounds keep ink that arrived meanwhile and count as a change", () => {
  const { sheets, state, create, ink } = setup("practice");
  const draft = create(); sheets.setInk(state, ink(1));
  sheets.accepted(sheets.capture(state)!);
  sheets.setPalette("light-a", "light", new Map([[state, { id: draft.id, background: "data:image/png;base64,NEW", backgroundColor: "rgb(255, 255, 255)" }]]));
  assert.equal(state.draft!.theme, "light"); assert.equal(state.draft!.background, "data:image/png;base64,NEW"); assert.ok(state.draft!.ink);
  assert.equal(sheets.pending(state), true, "a new theme is new image content");
  sheets.setPalette("dark-b", "dark", new Map([[state, { id: draft.id + 1, background: "x", backgroundColor: "y" }]]));
  assert.equal(state.draft!.palette, "light-a", "a background for another draft is not applied");
});
it("describes the connection in one line", () => {
  const status = (devices: Status["devices"], extra: Partial<Status> = {}): Status =>
    ({ serverId: "id", name: "mac", port: 47600, error: null, discoveryError: null, devices, pairing: null, activeWindow: null, ...extra });
  const device = (connected: boolean) => ({ id: "d", name: "Study iPad", pairedAt: "2026-11-25T10:00:00.000Z", connected });
  assert.equal(linkLine(undefined, "w1", true).state, "waiting");
  assert.deepEqual(linkLine(status([], { error: "Port 47600 is already in use." }), "w1", true), { state: "problem", text: "Port 47600 is already in use." });
  assert.match(linkLine(status([]), "w1", true).text, /No iPad paired/);
  assert.equal(linkLine(status([device(false)]), "w1", true).text, "Waiting for iPad…");
  assert.deepEqual(linkLine(status([device(true)], { activeWindow: "w1" }), "w1", true), { state: "connected", text: "Study iPad connected" });
  assert.equal(linkLine(status([device(true)], { activeWindow: "w2" }), "w1", true).text, "iPad is drawing in another window");
});
