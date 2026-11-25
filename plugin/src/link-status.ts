/** The background service's status as the window sees it. */
export interface Status {
  serverId: string;
  name: string;
  port: number | null;
  error: string | null;
  discoveryError: string | null;
  devices: { id: string; name: string; pairedAt: string; connected: boolean }[];
  pairing: { uri: string; expiresAt: number } | null;
  activeWindow: string | null;
}
export function parseStatus(value: unknown): Status {
  const input = value as Status | null;
  if (!input || typeof input !== "object" || typeof input.serverId !== "string" || !Array.isArray(input.devices) ||
    !input.devices.every(device => device && typeof device.id === "string" && typeof device.name === "string" && typeof device.connected === "boolean") ||
    (input.pairing !== null && (typeof input.pairing?.uri !== "string" || typeof input.pairing.expiresAt !== "number")))
    throw new Error("Remote Draw returned an unreadable status.");
  return input;
}
export interface LinkLine { state: "connected" | "waiting" | "problem"; text: string }
/** One line for the pad: can the iPad draw here right now, and if not, why. */
export function linkLine(status: Status | undefined, windowId: string, padOpen: boolean): LinkLine {
  if (!status) return { state: "waiting", text: "Checking the iPad connection…" };
  if (status.error) return { state: "problem", text: status.error };
  if (!status.devices.length) return { state: "waiting", text: "No iPad paired. Pair one in Settings → Remote Draw." };
  const connected = status.devices.find(device => device.connected);
  if (!connected) return { state: "waiting", text: "Waiting for iPad…" };
  if (padOpen && status.activeWindow !== null && status.activeWindow !== windowId)
    return { state: "waiting", text: "iPad is drawing in another window" };
  return { state: "connected", text: `${connected.name} connected` };
}
