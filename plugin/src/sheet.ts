import type { PluginButtonProps, PluginFrontendContext, PluginSessionViewInput, PluginWidgetHandle } from "learnharness-plugin-api";
import { captureBackground } from "./capture.ts";
import { frame } from "./abort.ts";
import { referenceFor, mountReference } from "./reference.ts";
import { referenceBounds, sheetOrigin, toWorld, viewOrigin } from "./geometry.ts";
import type { LinkLine } from "./link-status.ts";
import type { PreviewMessage } from "./protocol.ts";
import type { PublishReason, SessionSheet, Sheets } from "./state.ts";
import { appPalette } from "./theme.ts";

/** An ended preview line whose rendered ink never arrives is removed after this long. */
export const PREVIEW_TTL_MS = 5000;
export interface MountedSheet {
  dispose(): void;
  /** A piece of the stroke being drawn on the iPad right now. */
  preview(message: PreviewMessage): void;
  /** The rendered ink now contains every stroke up to this number. */
  inkThrough(stroke: number): void;
  /** The iPad went away or came back: its stroke numbers start over. */
  resetPreviews(): void;
  setLink(line: LinkLine): void;
}
interface PreviewStroke { color: string; width: number; points: { x: number; y: number }[]; endedAt?: number }

/** The desktop pad: question picture, the iPad's rendered ink, and live preview
 * lines. Nothing is drawn here; dragging moves the view. */
export function mountSheet(container: HTMLElement, ctx: PluginFrontendContext, sheets: Sheets, state: SessionSheet,
  input: PluginSessionViewInput, signal: AbortSignal, hooks: { clear(): void; link: LinkLine }): MountedSheet {
  const root = document.createElement("div"); root.className = "remote-draw-root";
  const toolbar = document.createElement("div"); toolbar.className = "remote-draw-tools";
  toolbar.setAttribute("role", "group"); toolbar.setAttribute("aria-label", "Remote Draw");
  const viewport = document.createElement("div"); viewport.className = "remote-draw-viewport";
  viewport.tabIndex = -1; viewport.dataset.pluginInitialFocus = "";
  viewport.setAttribute("role", "group"); viewport.setAttribute("aria-label", "Drawing sheet. Draw on the iPad; drag here to move the view.");
  const paper = document.createElement("div"); paper.className = "remote-draw-paper";
  const background = document.createElement("img"); background.alt = "Frozen question reference";
  background.className = "remote-draw-background"; background.draggable = false;
  const ink = document.createElement("img"); ink.alt = "Drawing from the iPad";
  ink.className = "remote-draw-ink"; ink.draggable = false;
  const canvas = document.createElement("canvas"); canvas.className = "remote-draw-preview"; canvas.setAttribute("aria-hidden", "true");
  const status = document.createElement("div"); status.className = "remote-draw-status"; status.setAttribute("role", "status");
  const link = document.createElement("span"); link.className = "remote-draw-link"; link.setAttribute("role", "status");
  paper.append(background, ink, canvas); viewport.append(paper, status); root.append(toolbar, viewport); container.append(root);
  let disposed = false, preparing = !state.draft, failure: string | undefined;
  let reference: HTMLElement | undefined, referenceMount: ReturnType<typeof mountReference> | undefined;
  let drag: { pointerId: number; x: number; y: number; pan: SessionSheet["pan"] } | undefined;
  let origin = { x: 0, y: 0 }, previewFrame: number | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  const previews = new Map<number, PreviewStroke>();
  const clearTarget = document.createElement("span"); toolbar.append(clearTarget, link);
  const clear: PluginWidgetHandle<PluginButtonProps> = ctx.ui.mountButton(clearTarget,
    { label: "Clear", title: "Clear the drawing here and on the iPad", onClick: () => hooks.clear(), variant: "outline", size: "sm", disabled: true }, { signal });
  const setLink = (line: LinkLine) => { link.dataset.state = line.state; link.textContent = line.text; };

  const paintPreviews = () => {
    previewFrame = undefined;
    const draft = state.draft, context = canvas.getContext("2d");
    if (disposed || !draft || !context) return;
    const ratio = canvas.width / Math.max(1, viewport.clientWidth);
    context.resetTransform(); context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(ratio, 0, 0, ratio, origin.x * ratio, origin.y * ratio);
    context.lineCap = "round"; context.lineJoin = "round";
    for (const stroke of previews.values()) {
      const first = stroke.points[0];
      if (!first) continue;
      context.strokeStyle = context.fillStyle = stroke.color; context.lineWidth = stroke.width;
      context.beginPath();
      if (stroke.points.length === 1) { context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2); context.fill(); continue; }
      context.moveTo(first.x, first.y);
      for (const point of stroke.points) context.lineTo(point.x, point.y);
      context.stroke();
    }
  };
  const schedulePreviews = () => { if (!disposed && previewFrame === undefined) previewFrame = requestAnimationFrame(paintPreviews); };
  const expire = () => {
    expiry = undefined;
    const now = Date.now();
    let next = Infinity;
    for (const [id, stroke] of previews) {
      if (stroke.endedAt === undefined) continue;
      if (stroke.endedAt + PREVIEW_TTL_MS <= now) previews.delete(id); else next = Math.min(next, stroke.endedAt + PREVIEW_TTL_MS);
    }
    schedulePreviews();
    if (next !== Infinity && !disposed) expiry = setTimeout(expire, next - now + 1);
  };
  const layout = () => {
    const draft = state.draft;
    clear.update({ disabled: preparing || !!failure || !draft?.ink });
    status.hidden = !preparing && !failure;
    status.setAttribute("role", failure ? "alert" : "status");
    status.textContent = failure ?? (preparing ? "Preparing drawing sheet…" : "");
    paper.hidden = !draft || preparing || !!failure;
    if (disposed || !draft) return;
    // Keep the previous raster readable until the new palette is ready to replace it.
    paper.style.backgroundColor = draft.backgroundColor;
    const width = viewport.clientWidth, height = viewport.clientHeight;
    if (!width || !height) return;
    origin = viewOrigin(width, height, state.pan, draft.height);
    const bounds = referenceBounds(draft.width, draft.height);
    background.hidden = !draft.background;
    if (draft.background && background.getAttribute("src") !== draft.background) background.src = draft.background;
    background.style.width = `${draft.width}px`; background.style.height = `${draft.height}px`;
    background.style.left = `${origin.x + bounds.x}px`; background.style.top = `${origin.y + bounds.y}px`;
    ink.hidden = !draft.ink;
    if (draft.ink) {
      const at = toWorld(draft.ink.image, draft.height), source = `data:image/png;base64,${draft.ink.image.png}`;
      if (ink.getAttribute("src") !== source) ink.src = source;
      ink.style.width = `${at.width}px`; ink.style.height = `${at.height}px`;
      ink.style.left = `${origin.x + at.x}px`; ink.style.top = `${origin.y + at.y}px`;
    }
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelsWide = Math.max(1, Math.round(width * pixelRatio)), pixelsHigh = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
    if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
    paintPreviews();
  };
  const down = (event: PointerEvent) => {
    if (drag || preparing || failure || !state.draft || (event.pointerType === "mouse" && event.button !== 0 && event.button !== 2)) return;
    event.preventDefault(); viewport.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan: state.pan };
    viewport.setPointerCapture(event.pointerId); viewport.toggleAttribute("data-panning", true);
  };
  const move = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) sheets.setPan(state, { x: drag.pan.x + event.clientX - drag.x, y: drag.pan.y + event.clientY - drag.y });
  };
  const finish = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = undefined; viewport.removeAttribute("data-panning");
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener("pointerdown", down, { signal });
  viewport.addEventListener("pointermove", move, { signal });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) viewport.addEventListener(name, finish, { signal });
  viewport.addEventListener("contextmenu", event => event.preventDefault(), { signal });
  viewport.addEventListener("wheel", event => event.preventDefault(), { signal, passive: false });
  const unsubscribe = sheets.onChange((_reason: PublishReason) => { if (!disposed) layout(); });
  const resize = new ResizeObserver(layout); resize.observe(viewport);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
    clearTimeout(expiry); previews.clear();
    unsubscribe(); resize.disconnect(); referenceMount?.dispose(); clear.dispose();
    signal.removeEventListener("abort", dispose); root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  setLink(hooks.link); layout();
  if (preparing) void (async () => {
    try {
      await frame(signal);
      signal.throwIfAborted();
      const width = viewport.clientWidth, height = viewport.clientHeight;
      const content = referenceFor(input);
      let slots: HTMLElement[] = [];
      if (content) {
        reference = document.createElement("div"); reference.className = "remote-draw-reference";
        // CSS mirrors the native composer's normal question-content width,
        // independent of the viewport. Freeze that wrapping once for this sheet.
        reference.setAttribute("aria-hidden", "true");
        root.append(reference);
        referenceMount = mountReference(reference, ctx, content, signal); slots = referenceMount.slots;
      }
      let palette: ReturnType<typeof appPalette>, sheet: Awaited<ReturnType<typeof captureBackground>>;
      do {
        palette = appPalette();
        sheet = await captureBackground(reference, slots, width, height, getComputedStyle(root).backgroundColor, signal);
      } while (palette.key !== appPalette().key);
      if (disposed || signal.aborted) return;
      preparing = false;
      sheets.create(state, { ...sheet, reference: content, palette: palette.key, theme: palette.mode });
    } catch (error) {
      if (!disposed && !signal.aborted) {
        preparing = false; failure = `Could not prepare the drawing background. ${error instanceof Error ? error.message : ""} Close and reopen Remote Draw to try again.`;
        layout();
      }
    } finally { referenceMount?.dispose(); reference?.remove(); }
  })();
  return {
    dispose, setLink,
    preview(message) {
      const draft = state.draft;
      if (disposed || !draft || draft.sheetId !== message.sheet) return;
      if (message.cancelled) { previews.delete(message.stroke); schedulePreviews(); return; }
      let stroke = previews.get(message.stroke);
      if (!stroke) previews.set(message.stroke, stroke = { color: message.color, width: message.width, points: [] });
      const zero = sheetOrigin(draft.height);
      for (const [x, y] of message.points) stroke.points.push({ x: x - zero.x, y: y - zero.y });
      if (message.end) { stroke.endedAt = Date.now(); if (expiry === undefined) expiry = setTimeout(expire, PREVIEW_TTL_MS + 1); }
      schedulePreviews();
    },
    inkThrough(through) {
      let removed = false;
      for (const id of previews.keys()) if (id <= through) { previews.delete(id); removed = true; }
      if (removed) schedulePreviews();
    },
    resetPreviews() { if (previews.size) { previews.clear(); schedulePreviews(); } },
  };
}
