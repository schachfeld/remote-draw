import { DEFAULT_IMAGE_SCALE } from "./store-defaults.ts";
import type { Picture, Theme } from "./protocol.ts";
import type { Reference } from "./reference.ts";

/** The iPad's latest rendering. `image` is in sheet coordinates, `png` base64. */
export interface Ink { theme: Theme; drawing: string; image: Picture; signature: string }
export interface Draft {
  id: number;
  /** The name this sheet has on the wire. A new draft is a new sheet for the iPad. */
  sheetId: string;
  revision: number;
  /** Raster of the reference alone; empty on blank sheets. No viewport baked in. */
  background: string;
  backgroundColor: string;
  /** Original learner-visible content and the palette used for this raster. */
  reference?: Reference;
  palette?: string;
  theme: Theme;
  width: number;
  height: number;
  pixelRatio: number;
  ink?: Ink;
  /** The newest relay sequence number applied to this draft. */
  seq: number;
}
export interface SessionSheet {
  readonly id: string;
  readonly kind: "teaching" | "practice";
  draft?: Draft;
  pan: { x: number; y: number };
  readonly seenPoses: Set<string>;
  sentSignature: string;
  readTicket: number;
}
export type PublishReason = "sheet" | "ink" | "camera";
export interface Capture { session: SessionSheet; draft: Draft; ink?: Ink; signature: string; imageScale: number; sendImage: boolean }
export interface IncomingInk { sheet: string; seq: number; theme: Theme; drawing?: string; image?: Picture }

/** Content identity of a rendering: the same picture at the same place is the
 * same drawing, so an undo back to what was already sent is not sent again. */
export function inkSignature(image: Picture): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < image.png.length; i++) hash = Math.imul(hash ^ image.png.charCodeAt(i), 0x01000193);
  return `${image.x},${image.y},${image.width},${image.height},${image.png.length},${(hash >>> 0).toString(16)}`;
}

/** Window-owned only. No storage, navigation parsing, or host input reconstruction. */
export class Sheets {
  readonly sessions = new Map<string, SessionSheet>();
  imageScale = DEFAULT_IMAGE_SCALE;
  private nextId = 0;
  private readonly listeners = new Set<(reason: PublishReason) => void>();
  constructor(private readonly windowId: string, private readonly changed: (reason: PublishReason) => void,
    private readonly newProblem: (session: SessionSheet) => void) {}
  onChange(listener: (reason: PublishReason) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(reason: PublishReason): void { this.changed(reason); for (const listener of this.listeners) listener(reason); }
  session(id: string, kind: SessionSheet["kind"]): SessionSheet {
    let state = this.sessions.get(id);
    if (!state) {
      state = { id, kind, pan: { x: 0, y: 0 }, seenPoses: new Set(), sentSignature: "", readTicket: 0 };
      this.sessions.set(id, state);
    }
    if (state.kind !== kind) throw new Error("Drawing session kind changed.");
    return state;
  }
  /** Atomically replace re-rendered reference backgrounds. Merge into the
   * latest draft so ink that arrived during rasterization is retained. */
  setPalette(palette: string, theme: Theme, backgrounds: ReadonlyMap<SessionSheet, { id: number; background: string; backgroundColor: string }>): void {
    let changed = false;
    for (const state of this.sessions.values()) {
      const draft = state.draft, background = backgrounds.get(state);
      if (!draft || background?.id !== draft.id || draft.palette === palette) continue;
      state.draft = { ...draft, background: background.background, backgroundColor: background.backgroundColor, palette, theme, revision: draft.revision + 1 };
      changed = true;
    }
    if (changed) this.publish("sheet");
  }
  /** Delivery resolution is not a drawing edit and does not trigger practice resends. */
  setImageScale(imageScale: number): void { this.imageScale = imageScale; }
  create(state: SessionSheet, sheet: Omit<Draft, "id" | "sheetId" | "revision" | "ink" | "seq">): Draft {
    const id = ++this.nextId;
    const draft: Draft = { ...sheet, id, sheetId: `${this.windowId}_${id}`, revision: 0, seq: 0 };
    state.draft = draft;
    state.pan = { x: 0, y: 0 };
    this.publish("sheet");
    return draft;
  }
  /** Apply a rendering from the iPad. Out-of-order and repeated deliveries are
   * ignored; an identical re-rendering is not an edit. True when ink changed. */
  setInk(state: SessionSheet, incoming: IncomingInk): boolean {
    const draft = state.draft;
    if (!draft || draft.sheetId !== incoming.sheet || incoming.seq <= draft.seq) return false;
    if (!incoming.image || incoming.drawing === undefined) {
      const { ink, ...rest } = draft;
      state.draft = { ...rest, seq: incoming.seq, revision: draft.revision + (ink ? 1 : 0) };
      if (ink) this.publish("ink");
      return !!ink;
    }
    const signature = inkSignature(incoming.image);
    const ink: Ink = { theme: incoming.theme, drawing: incoming.drawing, image: incoming.image, signature };
    const same = draft.ink?.signature === signature;
    state.draft = { ...draft, seq: incoming.seq, ink, revision: draft.revision + (same ? 0 : 1) };
    if (!same) this.publish("ink");
    return !same;
  }
  /** Camera movement is not a content edit and cannot invalidate an acceptance. */
  setPan(state: SessionSheet, pan: SessionSheet["pan"]): void { state.pan = pan; this.publish("camera"); }
  /** True when there was ink to remove. */
  clear(state: SessionSheet): boolean {
    const draft = state.draft;
    if (!draft?.ink) return false;
    const { ink: _ink, ...rest } = draft;
    state.draft = { ...rest, revision: draft.revision + 1 };
    this.publish("ink");
    return true;
  }
  dropUntouched(state: SessionSheet): void {
    if (state.draft && !state.draft.ink) { state.draft = undefined; this.publish("sheet"); }
  }
  signature(state: SessionSheet): string {
    const draft = state.draft;
    return draft?.ink ? `${draft.id}:${draft.palette ?? ""}:${draft.ink.signature}` : "";
  }
  pending(state: SessionSheet): boolean {
    const signature = this.signature(state);
    return !!signature && (state.kind === "teaching" || signature !== state.sentSignature);
  }
  capture(state: SessionSheet): Capture | undefined {
    const draft = state.draft;
    if (!draft) return undefined;
    const signature = this.signature(state);
    return { session: state, draft, ink: draft.ink, imageScale: this.imageScale, signature,
      sendImage: !!signature && (state.kind === "teaching" || signature !== state.sentSignature) };
  }
  /** True when the accepted drawing was removed from the sheet (teaching). */
  accepted(captured: Capture): boolean {
    const state = captured.session;
    if (state.draft?.id !== captured.draft.id) return false; // A new problem/sheet supersedes this acceptance.
    if (state.kind === "practice") {
      if (captured.sendImage) { state.sentSignature = captured.signature; this.publish("ink"); }
      return false;
    }
    return state.draft.revision === captured.draft.revision && this.clear(state);
  }
  /** Only accepted pose identities count. Conclusion/dismissal never reach this reset. */
  observePoses(state: SessionSheet, poses: readonly string[], baseline = false): boolean {
    if (state.kind !== "practice") return false;
    const latest = poses.at(-1);
    const newLatest = latest !== undefined && !state.seenPoses.has(latest);
    for (const pose of poses) state.seenPoses.add(pose);
    if (!newLatest || baseline) return false;
    state.draft = undefined;
    state.sentSignature = "";
    state.pan = { x: 0, y: 0 };
    this.newProblem(state);
    this.publish("sheet");
    return true;
  }
  dispose(): void { this.sessions.clear(); this.listeners.clear(); }
}
