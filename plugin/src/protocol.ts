/** Wire contract of protocol/PROTOCOL.md. Keep both in step. */
export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47600;
export const WS_PATH = "/remote-draw/v1";
export const SERVICE_TYPE = "remotedraw";
export const SHEET_SIZE = 4000;
export const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
export const PAIRING_TTL_MS = 5 * 60_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const PING_INTERVAL_MS = 15_000;
export const MAX_PREVIEW_POINTS = 512;

export const CLOSE = { replaced: 4001, unsupportedVersion: 4002, unauthorized: 4003, badMessage: 4008, busy: 4009, forgotten: 4010 } as const;
export type ErrorCode = "unauthorized" | "busy" | "bad-message" | "unsupported-version";
export type Theme = "light" | "dark";
export interface Rect { x: number; y: number; width: number; height: number }
export interface Picture extends Rect { png: string }
export interface SheetState { id: string; theme: Theme; backgroundColor: string; reference?: Picture; drawing?: string }

export type ServerMessage =
  | { type: "hello"; v: typeof PROTOCOL_VERSION; serverId: string; nonce: string }
  | { type: "paired" | "ready"; proof: string }
  | { type: "pad"; open: false }
  | { type: "pad"; open: true; sheet: SheetState }
  | { type: "clear"; sheet: string }
  | { type: "error"; code: ErrorCode; message: string };

export interface PairMessage { type: "pair"; deviceId: string; deviceName: string; nonce: string; proof: string }
export interface AuthMessage { type: "auth"; deviceId: string; nonce: string; proof: string }
export interface PreviewMessage { type: "preview"; sheet: string; stroke: number; color: string; width: number; points: [number, number][]; end: boolean; cancelled: boolean }
export interface InkMessage { type: "ink"; sheet: string; through: number; theme: Theme; drawing: string; image?: Picture }
export type ClientMessage = PairMessage | AuthMessage | PreviewMessage | InkMessage;

export class ProtocolError extends Error {}
const fail = (message: string): never => { throw new ProtocolError(message); };

const SHEET_ID = /^[A-Za-z0-9_-]{1,128}$/, DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/, NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/, COLOR = /^#[0-9a-fA-F]{6}$/, BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// The first eight PNG bytes, base64-encoded, always start with these characters.
const PNG_PREFIX = "iVBORw0KGgo";

type Fields = Record<string, unknown>;
function text(input: Fields, key: string, pattern: RegExp): string {
  const value = input[key];
  return typeof value === "string" && pattern.test(value) ? value : fail(`Invalid ${key}.`);
}
function finite(input: Fields, key: string): number {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fail(`Invalid ${key}.`);
}
function base64(input: Fields, key: string): string {
  const value = input[key];
  return typeof value === "string" && value.length > 0 && BASE64.test(value) ? value : fail(`Invalid ${key}.`);
}
export function isSheetId(value: unknown): value is string { return typeof value === "string" && SHEET_ID.test(value); }
export function isTheme(value: unknown): value is Theme { return value === "light" || value === "dark"; }
export function parsePicture(value: unknown, name: string): Picture {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid ${name}.`);
  const input = value as Fields;
  const rect = { x: finite(input, "x"), y: finite(input, "y"), width: finite(input, "width"), height: finite(input, "height") };
  if (rect.width <= 0 || rect.height <= 0) fail(`Invalid ${name} size.`);
  const png = base64(input, "png");
  if (!png.startsWith(PNG_PREFIX)) fail(`${name} is not a PNG.`);
  return { ...rect, png };
}
/** Validates everything the server relies on. Unknown fields are dropped. */
export function parseSheetState(value: unknown): SheetState {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid sheet.");
  const input = value as Fields;
  if (!isTheme(input.theme)) fail("Invalid theme.");
  return { id: text(input, "id", SHEET_ID), theme: input.theme as Theme, backgroundColor: text(input, "backgroundColor", COLOR),
    ...(input.reference !== undefined ? { reference: parsePicture(input.reference, "reference") } : {}),
    ...(input.drawing !== undefined ? { drawing: base64(input, "drawing") } : {}) };
}
export function parseClientMessage(raw: string): ClientMessage {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("Message is not JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Message is not an object.");
  const input = value as Fields;
  switch (input.type) {
    case "pair": {
      const deviceName = typeof input.deviceName === "string" ? input.deviceName.trim() : "";
      if (!deviceName || deviceName.length > 64) fail("Invalid deviceName.");
      return { type: "pair", deviceId: text(input, "deviceId", DEVICE_ID), deviceName, nonce: text(input, "nonce", NONCE), proof: text(input, "proof", PROOF) };
    }
    case "auth":
      return { type: "auth", deviceId: text(input, "deviceId", DEVICE_ID), nonce: text(input, "nonce", NONCE), proof: text(input, "proof", PROOF) };
    case "preview": {
      const stroke = input.stroke, width = finite(input, "width"), points = input.points;
      if (!Number.isSafeInteger(stroke) || (stroke as number) < 1) fail("Invalid stroke.");
      if (width <= 0 || width > 100) fail("Invalid width.");
      if (typeof input.end !== "boolean") fail("Invalid end.");
      if (input.cancelled !== undefined && typeof input.cancelled !== "boolean") fail("Invalid cancelled.");
      if (input.cancelled === true && input.end !== true) fail("Only an ended stroke can be cancelled.");
      if (!Array.isArray(points) || points.length > MAX_PREVIEW_POINTS) fail("Invalid points.");
      const parsed = (points as unknown[]).map(point => Array.isArray(point) && point.length === 2 &&
        point.every(n => typeof n === "number" && Number.isFinite(n)) ? [point[0], point[1]] as [number, number] : fail("Invalid point."));
      return { type: "preview", sheet: text(input, "sheet", SHEET_ID), stroke: stroke as number, color: text(input, "color", COLOR).toLowerCase(),
        width, points: parsed, end: input.end as boolean, cancelled: input.cancelled === true };
    }
    case "ink": {
      const through = input.through;
      if (!Number.isSafeInteger(through) || (through as number) < 0) fail("Invalid through.");
      if (!isTheme(input.theme)) fail("Invalid theme.");
      return { type: "ink", sheet: text(input, "sheet", SHEET_ID), through: through as number, theme: input.theme as Theme,
        drawing: base64(input, "drawing"), ...(input.image !== undefined ? { image: parsePicture(input.image, "image") } : {}) };
    }
    default: return fail("Unknown message type.");
  }
}
