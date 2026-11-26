import type { PluginAction, PluginActionContext, PluginFrontendContext, PluginSurfaceProps, PluginWidgetHandle } from "learnharness-plugin-api";
import { abortable } from "./abort.ts";
import { exportSheet } from "./capture.ts";
import { Follower } from "./follow.ts";
import { referenceOnSheet } from "./geometry.ts";
import { TABLET } from "./icons.ts";
import { linkLine, parseStatus, type Status } from "./link-status.ts";
import { acceptedPoseKeys, occurrenceKey, parsePoseResponse } from "./poses.ts";
import type { PreviewMessage, SheetState } from "./protocol.ts";
import { mountSettings } from "./settings-view.ts";
import { mountSheet, type MountedSheet } from "./sheet.ts";
import { Sheets, type IncomingInk, type SessionSheet } from "./state.ts";
import { parseSettings, type Settings } from "./store-defaults.ts";
import { appendDrawing } from "./submission.ts";
import { appPalette, captureReference, colorHex, recolorReference } from "./theme.ts";

/** How often an open pad confirms itself to the background service, which
 * treats a window silent for 30 seconds as gone. */
export const KEEP_PAD_MS = 10_000;
/** How often the window looks at which page is in front while no pad is open. */
export const FOLLOW_MS = 1000;
type SessionAction = Extract<PluginActionContext, { surface: "session" }>;
interface OpenPad {
  session: SessionSheet;
  controller: AbortController;
  handle?: PluginWidgetHandle<PluginSurfaceProps>;
  mounted?: MountedSheet;
  closed: boolean;
}
function newWindowId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "w" + [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function activate(ctx: PluginFrontendContext): Promise<() => void> {
  const windowId = newWindowId();
  let disposed = false, open: OpenPad | undefined, current: Settings | undefined, status: Status | undefined;
  const cleanups: (() => void)[] = [], observers = new Set<() => void>();
  const paletteController = new AbortController();
  let appliedPalette = appPalette().key, paletteTask: Promise<void> | undefined;
  // Opaque public path strings are associated ONLY on an actual contextual click.
  // No route parsing or global-current-session inference is used for targeting.
  const pageSessions = new Map<string, string>();
  const report = (error: unknown) => { if (!disposed && !ctx.signal.aborted) console.error("Remote Draw could not sync; existing work is kept.", error); };
  const live = () => !disposed && !ctx.signal.aborted;
  // Everything the host reads from this plugin: the button label (pending) and
  // hasPendingInput (pending, plus seenPoses for practice problem targets).
  let hostKey: string | undefined;
  const sheets = new Sheets(windowId, reason => {
    if (!live() || reason === "camera") return;
    const key = [...sheets.sessions.values()].map(state => `${state.id}:${sheets.pending(state) ? 1 : 0}:${state.draft ? 1 : 0}:` +
      `${state.draft?.ink ? 1 : 0}:${state.seenPoses.size}`).join("|");
    if (key !== hostKey) { hostKey = key; ctx.refreshActions(); ctx.refreshSubmissions(); }
    // A followed sheet that was reset or emptied is made again for the current question.
    if (reason === "sheet" || (reason === "ink" && follower.followed?.draft && !follower.followed.draft.ink)) follower.follow();
    if (reason === "sheet") {
      syncPad();
      if ([...sheets.sessions.values()].some(state => state.draft && state.draft.palette !== appPalette().key)) void refreshPalette().catch(report);
    }
  }, state => { if (open?.session === state) close(open); });

  // ---- The sheet the background service and the iPad see ------------------
  // The open pad's sheet, or with no pad open the sheet of the session page in front.
  let padKey = "", padQueue: Promise<unknown> = Promise.resolve();
  const padOpen = () => !!open && !open.closed;
  const target = () => padOpen() ? open!.session : follower.followed;
  function wireSheet(): SheetState | null {
    const draft = target()?.draft;
    if (!draft) return null;
    const reference = draft.background ? { ...referenceOnSheet(draft.width, draft.height), png: draft.background.slice(draft.background.indexOf(",") + 1) } : undefined;
    return { id: draft.sheetId, theme: draft.theme, backgroundColor: colorHex(draft.backgroundColor),
      ...(reference ? { reference } : {}), ...(draft.ink ? { drawing: draft.ink.drawing } : {}) };
  }
  /** Tell the service which sheet is open here. Ink changes are not re-sent:
   * the iPad already has them. */
  function syncPad(force = false): void {
    if (!live() && !force) return;
    const draft = target()?.draft;
    const key = draft ? `${draft.sheetId}|${draft.palette ?? ""}|${draft.background.length}` : "";
    if (key === padKey && !force) return;
    padKey = key;
    let sheet: SheetState | null;
    try { sheet = wireSheet(); } catch (error) { report(error); return; }
    padQueue = padQueue.then(() => ctx.call("set-pad", { windowId, sheet })).then(() => { if (sheet) void fetchInk().catch(report); }, report);
  }
  async function fetchInk(): Promise<void> {
    const state = target(), draft = state?.draft;
    if (!state || !draft) return;
    const value = await ctx.call("get-ink", { windowId, sheet: draft.sheetId }) as (IncomingInk & { through: number }) | null;
    if (!live() || !value || target() !== state) return;
    sheets.setInk(state, value);
    if (open?.session === state) open.mounted?.inkThrough(value.through);
  }
  /** Empty the sheet here and on the iPad. */
  function clearRemote(state: SessionSheet, sheetId: string | undefined): void {
    if (sheetId && target() === state)
      padQueue = padQueue.then(() => ctx.call("clear-sheet", { windowId, sheet: sheetId })).catch(report);
  }
  function applyStatus(value: unknown): void {
    if (!live()) return;
    const before = status?.devices.find(device => device.connected)?.id;
    status = parseStatus(value);
    if (before !== status.devices.find(device => device.connected)?.id) open?.mounted?.resetPreviews();
    open?.mounted?.setLink(linkLine(status, windowId, true));
    for (const observer of observers) observer();
    follow();
  }
  const refreshStatus = async () => applyStatus(await ctx.call("get-status"));

  function close(pad: OpenPad): void {
    if (pad.closed) return;
    pad.closed = true;
    if (open === pad) open = undefined;
    pad.mounted?.dispose(); pad.controller.abort(); pad.handle?.dispose();
    sheets.dropUntouched(pad.session);
    syncPad(true);
    follow();
  }

  // ---- Drawing without the pad ----------------------------------------------
  let lastStrokeAt = 0;
  const canReadSession = typeof ctx.app.currentSession === "function";
  const follower = new Follower(sheets, {
    live, padOpen, report,
    connected: () => !!status?.devices.some(device => device.connected),
    pathname: () => ctx.app.pathname(),
    ...(canReadSession ? { currentSession: () => ctx.app.currentSession() } : {}),
    call: (name, input) => ctx.call(name, input),
    async capture(reference, signal) {
      let palette: ReturnType<typeof appPalette>, sheet: Awaited<ReturnType<typeof captureReference>>;
      do { palette = appPalette(); sheet = await captureReference(ctx, reference, signal); } while (palette.key !== appPalette().key);
      return { ...sheet, palette: palette.key, theme: palette.mode };
    },
    lastStrokeAt: () => lastStrokeAt,
    sync: () => syncPad(),
    matched: (pathname, sessionId) => { pageSessions.set(pathname, sessionId); },
  });
  const follow = () => follower.follow();
  function toggle(context: SessionAction): void {
    if (!context.view) throw new Error("This LearnHarness build does not expose the session view context required by Remote Draw.");
    const hadState = sheets.sessions.has(context.sessionId);
    const state = sheets.session(context.sessionId, context.kind);
    const wasOpen = open?.session === state;
    pageSessions.set(ctx.app.pathname(), state.id);
    sheets.observePoses(state, acceptedPoseKeys(context.view.messages), !hadState);
    if (wasOpen) { if (open?.session === state) close(open); return; }
    if (open) close(open);
    // Acceptance can empty a sheet while it is closed. Apply the same empty-
    // sheet policy as close before deciding whether this mount needs a reference.
    sheets.dropUntouched(state);
    const pad: OpenPad = { session: state, controller: new AbortController(), closed: false };
    open = pad; follower.release();
    try {
      pad.handle = ctx.ui.openSurface(context.surfaceTarget, {
        title: "Remote Draw pad", background: "opaque",
        content(container, signal) {
          if (pad.closed || signal.aborted) return;
          const mounted = mountSheet(container, ctx, sheets, state, context.view.input, signal, {
            link: linkLine(status, windowId, true),
            clear() { const sheetId = state.draft?.sheetId; if (sheets.clear(state)) clearRemote(state, sheetId); },
          });
          pad.mounted = mounted;
          return () => {
            mounted.dispose();
            // Content mounts can be replayed by the host (e.g. development
            // StrictMode). Only the latest, genuinely departed mount owns close.
            queueMicrotask(() => {
              if (pad.mounted !== mounted) return;
              pad.mounted = undefined;
              close(pad);
            });
          };
        },
        onClose: () => close(pad),
      }, { signal: pad.controller.signal });
      if (pad.closed) pad.handle.dispose();
      else syncPad(); // A sheet that kept its ink is open again at once.
    } catch (error) { close(pad); throw error; }
  }
  const action: PluginAction = {
    id: "remote-draw", icon: TABLET,
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+r" },
    // A readonly string accessor uses public pathname + our click-time mapping;
    // no state capture occurs in disabled/render-time predicates.
    get name() {
      const id = pageSessions.get(ctx.app.pathname());
      const state = id ? sheets.sessions.get(id) : undefined;
      return state && sheets.pending(state) ? "Remote draw (unsent)" : "Remote draw";
    },
    run(context) { if (context.surface === "session") toggle(context); },
  };
  function applySettings(value: unknown): void {
    if (!live()) return;
    const next = parseSettings(value);
    if (current && next.revision <= current.revision) return;
    current = next; sheets.setImageScale(next.imageScale);
    for (const observer of observers) observer();
  }
  function refreshPalette(): Promise<void> {
    if (paletteTask) return paletteTask;
    paletteTask = (async () => {
      while (live()) {
        const palette = appPalette();
        const backgrounds = new Map<SessionSheet, { id: number; background: string; backgroundColor: string }>();
        for (const state of sheets.sessions.values()) {
          const draft = state.draft;
          if (draft && draft.palette !== palette.key) backgrounds.set(state,
            { id: draft.id, ...await recolorReference(draft, ctx, paletteController.signal) });
        }
        if (!live()) return;
        if (palette.key !== appPalette().key) continue;
        appliedPalette = palette.key;
        // The "sheet" publication re-sends the open pad, and the iPad answers
        // with ink rendered for the new theme.
        sheets.setPalette(palette.key, palette.mode, backgrounds);
        if (palette.key === appPalette().key) return;
      }
    })().finally(() => { paletteTask = undefined; });
    return paletteTask;
  }
  let settingsRead: Promise<void> = Promise.resolve();
  function refreshSettings(): Promise<void> {
    settingsRead = settingsRead.catch(() => {}).then(async () => { if (live()) applySettings(await ctx.call("get-settings")); });
    return settingsRead;
  }
  async function refreshPoses(state: SessionSheet, signal: AbortSignal): Promise<void> {
    const ticket = ++state.readTicket;
    const value = await abortable(ctx.call("get-session-poses", { sessionId: state.id }), signal);
    signal.throwIfAborted();
    if (disposed || sheets.sessions.get(state.id) !== state || ticket !== state.readTicket) return;
    sheets.observePoses(state, parsePoseResponse(value, state.id));
  }
  const dispose = () => {
    if (disposed) return;
    if (open) close(open);
    disposed = true;
    paletteController.abort(); follower.dispose();
    for (const cleanup of cleanups.splice(0)) cleanup();
    sheets.dispose(); pageSessions.clear(); observers.clear();
  };
  ctx.cleanup(dispose);
  cleanups.push(ctx.onNotification(event => {
    if (event.pluginId !== ctx.manifest.id || !live()) return;
    const data = event.data as Record<string, unknown> | undefined;
    if (event.topic === "settings-changed") applySettings(event.data);
    else if (event.topic === "status-changed") { try { applyStatus(event.data); } catch (error) { report(error); } }
    else if (data?.windowId !== windowId) return;
    else if (event.topic === "preview") { lastStrokeAt = Date.now(); open?.mounted?.preview(data as unknown as PreviewMessage); }
    else if (event.topic === "ink-updated") void fetchInk().catch(report);
  }));
  cleanups.push(ctx.onAppEvent(event => {
    if (event.type !== "turn-settled" && event.type !== "record-changed") return;
    if (follower.followed?.id === event.chatId) follow();
    const state = sheets.sessions.get(event.chatId);
    if (state?.kind === "practice") void refreshPoses(state, ctx.signal).catch(report);
  }));
  cleanups.push(ctx.onResync(() => {
    void refreshSettings().catch(report); void refreshStatus().catch(report);
    // The service may have restarted and forgotten this window's pad.
    syncPad(true); follow();
    for (const state of sheets.sessions.values()) if (state.kind === "practice") void refreshPoses(state, ctx.signal).catch(report);
  }));
  const keep = setInterval(() => {
    if (!live() || !padKey) return;
    void (ctx.call("keep-pad", { windowId }) as Promise<{ open: boolean }>).then(result => { if (live() && padKey && !result.open) syncPad(true); }, report);
  }, KEEP_PAD_MS);
  cleanups.push(() => clearInterval(keep));
  // There is no navigation event. A changed path is followed at once; an empty
  // sheet is checked against the question now and then, because revealing a
  // question raises no event either.
  let followTicks = 0, followedPath = "";
  const watch = setInterval(() => {
    if (!live() || padOpen() || !status?.devices.some(device => device.connected)) return;
    const path = ctx.app.pathname(), moved = path !== followedPath;
    followedPath = path;
    if (moved || (++followTicks % 2 === 0 && !follower.followed?.draft?.ink)) follow();
  }, FOLLOW_MS);
  cleanups.push(() => clearInterval(watch));
  if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => { void refreshPalette().catch(report); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    cleanups.push(() => observer.disconnect());
  }
  try {
    await refreshSettings();
    await refreshStatus();
    if (!live()) return dispose;
    cleanups.push(ctx.registerSettings((container, signal) => mountSettings(container, signal, ctx, {
      settings: () => current!, status: () => status,
      subscribe(listener) { observers.add(listener); return () => { observers.delete(listener); }; },
      async setImageScale(imageScale) { applySettings(await ctx.call("set-image-scale", { imageScale })); },
      async setPort(port) { applySettings(await ctx.call("set-port", { port })); await refreshStatus(); },
      async startPairing() { applyStatus(await ctx.call("start-pairing")); },
      async cancelPairing() { applyStatus(await ctx.call("cancel-pairing")); },
      async forget(deviceId) { applyStatus(await ctx.call("forget-device", { deviceId })); },
    })));
    cleanups.push(ctx.registerAction(action));
    cleanups.push(ctx.placeAction({ id: "session-remote-draw", actionId: "remote-draw", location: "top-bar", sessions: ["teaching", "practice"] }));
    cleanups.push(ctx.registerSubmissionInterceptor({
      id: "drawing", priority: 0,
      hasPendingInput(target) {
        const state = sheets.sessions.get(target.sessionId);
        if (!state || !sheets.pending(state)) return false;
        if (state.kind === "practice" && (target.type === "thinking" || target.type === "plugin-problem-submission") &&
          !state.seenPoses.has(occurrenceKey(target.problem.occurrence))) return false;
        return target.type === "text" || target.type === "thinking" || (target.type === "answer" && target.question.mode === "text");
      },
      async intercept(input, context) {
        const state = sheets.sessions.get(context.sessionId);
        if (!state) return;
        context.signal.throwIfAborted();
        if (state.kind === "practice") {
          sheets.observePoses(state, acceptedPoseKeys(context.messages));
          await refreshPoses(state, context.signal);
        }
        // Pose reads and palette rendering are asynchronous. Recheck the live
        // palette after the last await, immediately before freezing the attempt.
        do {
          await abortable(refreshPalette(), context.signal);
          paletteController.signal.throwIfAborted();
        } while (appPalette().key !== appliedPalette || (state.draft && state.draft.palette !== appliedPalette));
        context.signal.throwIfAborted();
        const captured = sheets.capture(state);
        if (!captured) return;
        const result = captured.sendImage ? appendDrawing(input, await exportSheet(captured, context.signal)) : input;
        context.signal.throwIfAborted();
        if (state.draft?.id !== captured.draft.id) throw new Error("The captured drawing sheet was reset. Review the current input and submit again.");
        context.onAccepted(() => { if (live() && sheets.accepted(captured)) clearRemote(state, captured.draft.sheetId); });
        return result;
      },
    }));
  } catch (error) { dispose(); throw error; }
  return dispose;
}
