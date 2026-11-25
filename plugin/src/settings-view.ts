import qrcode from "qrcode-generator";
import type { PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import type { Status } from "./link-status.ts";
import { imageScaleError, portError, type Settings } from "./store-defaults.ts";

export interface SettingsModel {
  settings(): Settings;
  status(): Status | undefined;
  /** Called again whenever settings or status change; returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  setImageScale(value: number): Promise<void>;
  setPort(value: number): Promise<void>;
  startPairing(): Promise<void>;
  cancelPairing(): Promise<void>;
  forget(deviceId: string): Promise<void>;
}
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function rows(model: SettingsModel): PluginSettingsSchema["rows"] {
  const value = model.settings();
  return [{
    key: "imageScale", type: "number", label: "Image scale", value: value.imageScale, min: 0, max: 100,
    description: "Size of the image sent with a submission, in percent (default 50%). Applied before the fixed 2000 × 2000 pixel cap.",
    validate: imageScaleError, onChange: next => model.setImageScale(next),
  }, {
    key: "port", type: "number", label: "Port", value: value.port, min: 1024, max: 65535, step: 1,
    description: "Network port the iPad connects to (default 47600). After a change, iPads on the same network reconnect by themselves; an iPad connecting over a tailnet has to be paired again.",
    validate: portError, onChange: next => model.setPort(next),
  }];
}
/** Settings → Remote Draw: preferences, paired iPads and the pairing QR code. */
export function mountSettings(container: HTMLElement, signal: AbortSignal, ctx: PluginFrontendContext, model: SettingsModel): () => void {
  const root = element("div", undefined, "remote-draw-settings");
  const preferences = element("div"), devices = element("section"), pairing = element("section");
  root.append(preferences, devices, pairing); container.append(root);
  const fields = ctx.ui.mountSettingsRows(preferences, { rows: rows(model) }, { signal });
  let handles: PluginWidgetHandle<unknown>[] = [], shown = "";
  const button = (parent: HTMLElement, label: string, onClick: () => Promise<void>, variant: "default" | "outline" = "outline") => {
    const target = element("span"); parent.append(target);
    handles.push(ctx.ui.mountButton(target, { label, onClick, variant, size: "sm" }, { signal }) as PluginWidgetHandle<unknown>);
  };
  const render = () => {
    if (signal.aborted) return;
    fields.update({ rows: rows(model) });
    const status = model.status(), key = JSON.stringify(status ?? null);
    if (key === shown) return;
    shown = key;
    for (const handle of handles.splice(0)) handle.dispose();
    devices.replaceChildren(element("h3", "Paired iPads"));
    pairing.replaceChildren();
    if (!status) { devices.append(element("p", "Checking…")); return; }
    if (status.error) { const alert = element("p", status.error); alert.setAttribute("role", "alert"); devices.append(alert); }
    if (status.discoveryError) devices.append(element("p",
      `The desktop could not announce itself on the network (${status.discoveryError}). Paired iPads can still connect by address.`));
    if (!status.devices.length) devices.append(element("p", "No iPad is paired yet."));
    else {
      const list = element("ul", undefined, "remote-draw-devices");
      for (const device of status.devices) {
        const item = element("li"), text = element("div", device.name);
        text.append(element("small", device.connected ? "Connected" : `Paired ${new Date(device.pairedAt).toLocaleDateString()}`));
        item.append(text); list.append(item);
        button(item, "Forget", () => model.forget(device.id));
      }
      devices.append(list);
    }
    if (status.pairing) {
      pairing.append(element("h3", "Scan with the Remote Draw app"),
        element("p", `Open Remote Draw on the iPad and scan this code. It works once and until ${new Date(status.pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`));
      const box = element("div", undefined, "remote-draw-pairing"), code = element("div", undefined, "remote-draw-qr");
      const qr = qrcode(0, "M"); qr.addData(status.pairing.uri); qr.make();
      code.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      code.setAttribute("role", "img"); code.setAttribute("aria-label", "Pairing QR code");
      const side = element("div");
      side.append(element("p", "The same code as text, for pairing without a camera:"), element("code", status.pairing.uri));
      box.append(code, side); pairing.append(box);
      button(side, "Cancel", () => model.cancelPairing());
    } else if (!status.error) button(pairing, "Pair an iPad", () => model.startPairing(), "default");
  };
  const unsubscribe = model.subscribe(render);
  render();
  return () => { unsubscribe(); for (const handle of handles.splice(0)) handle.dispose(); fields.dispose(); root.remove(); };
}
