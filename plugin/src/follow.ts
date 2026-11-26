import type { PluginSessionViewContext } from "learnharness-plugin-api";
import { abortable } from "./abort.ts";
import { parseKindResponse, sameReference, sessionIdFromPath } from "./page.ts";
import { acceptedPoseKeys, parsePoseResponse } from "./poses.ts";
import { referenceFor, type Reference } from "./reference.ts";
import type { Draft, SessionSheet, Sheets } from "./state.ts";

/** A stroke seen this recently may not have arrived as ink yet, so its sheet is not replaced. */
export const DRAWING_GRACE_MS = 5000;
type Picture = Omit<Draft, "id" | "sheetId" | "revision" | "ink" | "seq" | "reference">;
export interface FollowHost {
  live(): boolean;
  padOpen(): boolean;
  /** An iPad is connected. Without one no sheet is made. */
  connected(): boolean;
  pathname(): string;
  /** Missing on LearnHarness versions without `ctx.app.currentSession`. */
  currentSession?: () => { sessionId: string; kind: SessionSheet["kind"]; view: Pick<PluginSessionViewContext, "messages" | "input"> } | undefined;
  call(name: string, input: unknown): Promise<unknown>;
  /** The question picture for a new sheet, in the current palette. */
  capture(reference: Reference | undefined, signal: AbortSignal): Promise<Picture>;
  /** When the iPad last sent a piece of a stroke. */
  lastStrokeAt(): number;
  /** The followed session or its sheet changed: tell the background service. */
  sync(): void;
  /** A page was matched to a session. */
  matched(pathname: string, sessionId: string): void;
  report(error: unknown): void;
}
interface Page { id: string; kind: SessionSheet["kind"]; view?: Pick<PluginSessionViewContext, "messages" | "input"> }

/** Drawing without the pad. With an iPad connected and no pad open, the session
 * page in front gets a sheet of its own, so ink can go with the next submission
 * there. A submission only ever takes the sheet of its own session. */
export class Follower {
  /** The session whose sheet the iPad draws on while no pad is open. */
  followed: SessionSheet | undefined;
  private readonly controller = new AbortController();
  private task: Promise<void> | undefined;
  private again = false;
  constructor(private readonly sheets: Sheets, private readonly host: FollowHost) {}

  /** Look again at which page is in front. Safe to call often; runs are serialized. */
  follow(): void {
    if (!this.host.live()) return;
    if (this.task) { this.again = true; return; }
    this.task = Promise.resolve().then(async () => {
      do { this.again = false; await this.once(); } while (this.again && this.host.live());
    }).catch(error => { if (this.host.live()) this.host.report(error); })
      .finally(() => { this.task = undefined; if (this.again) this.follow(); });
  }
  /** Resolves when no run is in progress. */
  async idle(): Promise<void> { while (this.task) await this.task; }
  /** The pad took over: it owns its session's sheet now. */
  release(): void { this.followed = undefined; }
  dispose(): void { this.followed = undefined; this.controller.abort(); }

  private async page(): Promise<Page | undefined> {
    const host = this.host;
    if (host.currentSession) {
      const session = host.currentSession();
      return session && { id: session.sessionId, kind: session.kind, view: session.view };
    }
    // Older LearnHarness: the path names the session, but there is no question to show.
    const id = sessionIdFromPath(host.pathname());
    if (!id) return undefined;
    const kind = this.sheets.sessions.get(id)?.kind ?? parseKindResponse(await host.call("get-session-kind", { sessionId: id }), id);
    return kind && sessionIdFromPath(host.pathname()) === id ? { id, kind } : undefined;
  }
  private unfollow(): void {
    const previous = this.followed;
    this.followed = undefined;
    if (previous) this.sheets.dropUntouched(previous);
    this.host.sync();
  }
  private async once(): Promise<void> {
    const host = this.host, sheets = this.sheets;
    if (!host.live()) return;
    if (host.padOpen()) { this.followed = undefined; return; }
    const page = host.connected() ? await this.page() : undefined;
    if (!host.live() || host.padOpen()) return;
    if (!page) return this.unfollow();
    const known = sheets.sessions.get(page.id);
    if (known && known.kind !== page.kind) return this.unfollow();
    const state = sheets.session(page.id, page.kind);
    if (this.followed !== state) { const previous = this.followed; this.followed = state; if (previous) sheets.dropUntouched(previous); }
    host.matched(host.pathname(), state.id);
    const current = () => host.live() && this.followed === state && !host.padOpen();
    // A new practice problem resets the sheet, so know the problems before making one.
    if (page.view) sheets.observePoses(state, acceptedPoseKeys(page.view.messages), !known);
    else if (!known && state.kind === "practice") {
      const poses = parsePoseResponse(await abortable(host.call("get-session-poses", { sessionId: state.id }), this.controller.signal), state.id);
      if (!current()) return;
      sheets.observePoses(state, poses, true);
    }
    const draft = state.draft, reference = page.view && referenceFor(page.view.input);
    const drawing = () => Date.now() - host.lastStrokeAt() < DRAWING_GRACE_MS;
    // Ink freezes the sheet. An empty one follows the question as it changes.
    if (draft && (draft.ink || !host.currentSession || sameReference(draft.reference, reference) || drawing())) return host.sync();
    const picture = await host.capture(reference, this.controller.signal);
    if (!current() || state.draft !== draft || (draft && drawing())) return;
    sheets.create(state, { ...picture, reference });
  }
}
