import assert from "node:assert/strict";
import { it } from "node:test";
import { Follower, type FollowHost } from "../src/follow.ts";
import { parseKindResponse, sameReference, sessionIdFromPath } from "../src/page.ts";
import { Sheets } from "../src/state.ts";
import { PNG } from "./helpers.ts";

type Session = NonNullable<ReturnType<NonNullable<FollowHost["currentSession"]>>>;
const problem = (statement: string, kind: Session["kind"] = "practice", id = "s1"): Session => ({ sessionId: id, kind, view: { messages: [],
  input: { type: "thinking", problem: { statement, occurrence: { messageId: "m", contentIndex: 0, toolCallId: "t", toolName: "problem" } } } as unknown as Session["view"]["input"] } });
const text = (id: string, kind: Session["kind"] = "teaching"): Session => ({ sessionId: id, kind, view: { messages: [], input: { type: "text" } as unknown as Session["view"]["input"] } });
const posed = (id: string) => [{ role: "assistant", id: `m-${id}`, content: [{ type: "toolCall", id, name: "problem" }] }, { role: "toolResult", toolCallId: id, toolName: "problem" }];

function fixture(mode: "api" | "legacy") {
  const self = {
    live: true, padOpen: false, connected: true, path: "/", session: undefined as Session | undefined, stroke: 0,
    captures: [] as (string | undefined)[], syncs: 0, calls: [] as string[], errors: [] as unknown[], matched: [] as string[],
    kinds: new Map<string, string>(), poses: new Map<string, string[]>(), hold: undefined as Promise<void> | undefined,
  };
  let follower!: Follower;
  const sheets = new Sheets("window-aaaa", reason => { if (reason === "sheet") follower.follow(); }, () => {});
  const host: FollowHost = {
    live: () => self.live, padOpen: () => self.padOpen, connected: () => self.connected, pathname: () => self.path,
    ...(mode === "api" ? { currentSession: () => self.session } : {}),
    async call(name, input) {
      const { sessionId } = input as { sessionId: string };
      self.calls.push(`${name}:${sessionId}`);
      return name === "get-session-kind" ? { sessionId, kind: self.kinds.get(sessionId) ?? null } : { sessionId, poses: self.poses.get(sessionId) ?? [] };
    },
    async capture(reference) {
      self.captures.push(reference?.question);
      await self.hold;
      return { background: reference ? "data:image/png;base64," + PNG : "", backgroundColor: "#101010", width: reference ? 100 : 0, height: reference ? 40 : 0,
        pixelRatio: 2, palette: "p", theme: "dark" };
    },
    lastStrokeAt: () => self.stroke, sync: () => { self.syncs++; }, matched: (path, id) => { self.matched.push(`${path}=${id}`); },
    report: error => { self.errors.push(error); },
  };
  follower = new Follower(sheets, host);
  const run = async () => { follower.follow(); await follower.idle(); assert.deepEqual(self.errors, []); };
  const ink = (id: string) => {
    const state = sheets.sessions.get(id)!;
    sheets.setInk(state, { sheet: state.draft!.sheetId, seq: state.draft!.seq + 1, theme: "dark", drawing: "AAAA", image: { x: 1, y: 2, width: 3, height: 4, png: PNG } });
  };
  return { self, sheets, follower, run, ink };
}

it("reads the session from a chat path only", () => {
  assert.equal(sessionIdFromPath("/chat/abc_DEF-1"), "abc_DEF-1");
  assert.equal(sessionIdFromPath("/chat/abc/"), "abc");
  for (const path of ["/", "/chat", "/chat/new", "/chat/a/b", "/chat/a%2Fb", "/chat/%E0%A4%A", "/plugins/remote-draw/x", "/settings"])
    assert.equal(sessionIdFromPath(path), undefined, path);
  assert.equal(parseKindResponse({ sessionId: "a", kind: "practice" }, "a"), "practice");
  assert.equal(parseKindResponse({ sessionId: "a", kind: null }, "a"), undefined);
  assert.throws(() => parseKindResponse({ sessionId: "b", kind: "practice" }, "a"));
  assert.ok(sameReference(undefined, undefined));
  assert.ok(!sameReference(undefined, { label: "Problem", question: "q", options: [], multiple: false }));
});

it("gives the session in front a sheet with its question while no pad is open", async () => {
  const f = fixture("api");
  f.self.path = "/chat/s1"; f.self.session = problem("Add 2 and 3");
  await f.run();
  const state = f.follower.followed!;
  assert.equal(state.id, "s1"); assert.equal(state.kind, "practice");
  assert.equal(state.draft?.reference?.question, "Add 2 and 3"); assert.equal(state.draft?.width, 100);
  assert.deepEqual(f.self.captures, ["Add 2 and 3"]); assert.deepEqual(f.self.matched.at(-1), "/chat/s1=s1");
  assert.deepEqual(f.self.calls, []);
  // Looking again changes nothing: the same sheet stays on the iPad.
  const sheetId = state.draft!.sheetId;
  await f.run(); await f.run();
  assert.equal(state.draft!.sheetId, sheetId); assert.equal(f.self.captures.length, 1);
});

it("lets an empty sheet follow the question and freezes it once there is ink", async () => {
  const f = fixture("api");
  f.self.session = problem("First", "teaching");
  await f.run();
  const state = f.follower.followed!, first = state.draft!.sheetId;
  f.self.session = problem("Second", "teaching");
  await f.run();
  assert.notEqual(state.draft!.sheetId, first); assert.equal(state.draft!.reference?.question, "Second");
  f.ink("s1");
  const kept = state.draft!.sheetId;
  f.self.session = problem("Third", "teaching");
  await f.run();
  assert.equal(state.draft!.sheetId, kept); assert.equal(state.draft!.reference?.question, "Second");
  // Accepted and cleared: the next look brings the current question.
  f.sheets.clear(state);
  await f.run();
  assert.equal(state.draft!.reference?.question, "Third");
});

it("does not replace a sheet while a stroke is on its way", async () => {
  const f = fixture("api");
  f.self.session = problem("First", "teaching");
  await f.run();
  const state = f.follower.followed!, first = state.draft!.sheetId;
  f.self.session = problem("Second", "teaching"); f.self.stroke = Date.now();
  await f.run();
  assert.equal(state.draft!.sheetId, first);
  // Ink that lands while the new picture is being made also keeps the sheet.
  f.self.stroke = 0;
  let release!: () => void;
  f.self.hold = new Promise<void>(resolve => { release = resolve; });
  f.follower.follow(); await new Promise(resolve => setTimeout(resolve, 5));
  f.ink("s1"); release(); await f.follower.idle();
  assert.equal(state.draft!.sheetId, first); assert.ok(state.draft!.ink);
});

it("keeps ink with its own session when the page changes", async () => {
  const f = fixture("api");
  f.self.session = text("a");
  await f.run();
  const a = f.follower.followed!;
  assert.equal(a.draft?.background, "");
  f.ink("a");
  f.self.session = text("b");
  await f.run();
  const b = f.follower.followed!;
  assert.equal(b.id, "b"); assert.ok(a.draft?.ink, "the first session keeps its drawing"); assert.ok(f.sheets.pending(a));
  // An untouched sheet is dropped on leaving; a page that is no session follows nothing.
  f.self.session = undefined;
  await f.run();
  assert.equal(f.follower.followed, undefined); assert.equal(b.draft, undefined); assert.ok(a.draft?.ink);
  f.self.session = text("a");
  await f.run();
  assert.equal(f.follower.followed, a); assert.ok(a.draft?.ink);
});

it("makes no sheet without an iPad, and leaves the sheet to an open pad", async () => {
  const f = fixture("api");
  f.self.session = text("a"); f.self.connected = false;
  await f.run();
  assert.equal(f.follower.followed, undefined); assert.equal(f.sheets.sessions.size, 0);
  f.self.connected = true;
  await f.run();
  assert.equal((f.follower.followed as { id: string } | undefined)?.id, "a");
  f.self.padOpen = true; f.follower.release();
  await f.run();
  assert.equal(f.follower.followed, undefined); assert.ok(f.sheets.sessions.get("a")!.draft, "the pad's sheet is not dropped");
  f.self.padOpen = false; f.self.connected = false;
  await f.run();
  assert.equal(f.follower.followed, undefined);
});

it("resets a practice sheet for a new problem but not for the ones already there", async () => {
  const f = fixture("api");
  f.self.session = { ...problem("One"), view: { ...problem("One").view, messages: posed("p1") as never } };
  await f.run();
  const state = f.follower.followed!;
  f.ink("s1");
  const first = state.draft!.sheetId;
  await f.run();
  assert.equal(state.draft!.sheetId, first);
  f.self.session = { ...problem("Two"), view: { ...problem("Two").view, messages: [...posed("p1"), ...posed("p2")] as never } };
  await f.run();
  assert.notEqual(state.draft!.sheetId, first); assert.equal(state.draft!.ink, undefined); assert.equal(state.draft!.reference?.question, "Two");
});

it("falls back to the page path and a blank sheet on older LearnHarness", async () => {
  const f = fixture("legacy");
  f.self.kinds.set("old-1", "practice"); f.self.poses.set("old-1", ["pose-1"]);
  f.self.path = "/chat/old-1";
  await f.run();
  const state = f.follower.followed!;
  assert.equal(state.id, "old-1"); assert.equal(state.kind, "practice"); assert.ok(state.seenPoses.has("pose-1"));
  assert.equal(state.draft?.background, ""); assert.equal(state.draft?.reference, undefined);
  assert.deepEqual(f.self.calls, ["get-session-kind:old-1", "get-session-poses:old-1"]);
  // A blank sheet is not remade, and a known session is not asked about again.
  const sheetId = state.draft!.sheetId;
  await f.run();
  assert.equal(state.draft!.sheetId, sheetId); assert.equal(f.self.calls.length, 2); assert.equal(f.self.captures.length, 1);
  f.self.path = "/settings";
  await f.run();
  assert.equal(f.follower.followed, undefined);
  // Unknown sessions and non-session pages get nothing.
  f.self.path = "/chat/missing";
  await f.run();
  assert.equal(f.follower.followed, undefined); assert.equal(f.sheets.sessions.has("missing"), false);
});

it("stops when the plugin is disabled", async () => {
  const f = fixture("api");
  f.self.session = text("a");
  f.follower.follow(); f.self.live = false; f.follower.dispose();
  await f.follower.idle();
  assert.equal(f.follower.followed, undefined); assert.deepEqual(f.self.errors, []);
});
