import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PORT } from "./protocol.ts";
import type { LinkDevice } from "./link.ts";

export const DEFAULT_IMAGE_SCALE = 50;
export interface Settings { revision: number; imageScale: number; port: number }
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ revision: 0, imageScale: DEFAULT_IMAGE_SCALE, port: DEFAULT_PORT });

export function imageScaleError(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? undefined : "Enter a percentage greater than 0 and at most 100.";
}
export function portError(value: unknown): string | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1024 && (value as number) <= 65535
    ? undefined : "Enter a whole port number from 1024 to 65535.";
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value as Record<string, unknown>;
}
function only(input: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(input).some(key => !keys.includes(key))) throw new Error(`Invalid ${name}.`);
}
export function parseSettings(value: unknown): Settings {
  const input = record(value, "Remote Draw settings");
  only(input, ["revision", "imageScale", "port"], "Remote Draw settings");
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error("Invalid Remote Draw settings revision.");
  for (const error of [imageScaleError(input.imageScale), portError(input.port)]) if (error) throw new Error(error);
  return { revision: input.revision as number, imageScale: input.imageScale as number, port: input.port as number };
}
/** Exactly one field per change, so a stale form cannot overwrite the other. */
export function parseSettingsChange(value: unknown, key: "imageScale" | "port"): number {
  const input = record(value, `${key} setting`);
  if (Object.keys(input).length !== 1 || !(key in input)) throw new Error(`Expected exactly one ${key} setting.`);
  const error = key === "port" ? portError(input[key]) : imageScaleError(input[key]);
  if (error) throw new Error(error);
  return input[key] as number;
}

export interface Devices { serverId: string; devices: LinkDevice[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseDevices(value: unknown): Devices {
  const input = record(value, "Remote Draw device list");
  only(input, ["serverId", "devices"], "Remote Draw device list");
  if (typeof input.serverId !== "string" || !UUID.test(input.serverId) || !Array.isArray(input.devices)) throw new Error("Invalid Remote Draw device list.");
  const seen = new Set<string>();
  const devices = input.devices.map(entry => {
    const device = record(entry, "paired device");
    only(device, ["id", "name", "key", "pairedAt"], "paired device");
    const key = typeof device.key === "string" ? Buffer.from(device.key, "base64url") : Buffer.alloc(0);
    if (typeof device.id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(device.id) || seen.has(device.id) ||
      typeof device.name !== "string" || !device.name || device.name.length > 64 || key.length !== 32 ||
      typeof device.pairedAt !== "string" || Number.isNaN(Date.parse(device.pairedAt))) throw new Error("Invalid paired device.");
    seen.add(device.id);
    return { id: device.id, name: device.name, key, pairedAt: device.pairedAt };
  });
  return { serverId: input.serverId, devices };
}

function read<T>(file: string, parse: (value: unknown) => T): T | undefined {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return parse(JSON.parse(text));
}
function write(directory: string, name: string, value: unknown): void {
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, name));
  } finally { fs.rmSync(temporary, { force: true }); }
}
/** Plugin-owned files. A corrupt file throws instead of being silently replaced,
 * so a damaged device list never turns into "nothing is paired" plus a new ID. */
export class Store {
  settings: Settings;
  private state: Devices;
  private idSaved: boolean;
  constructor(private readonly directory: string) {
    this.settings = read(path.join(directory, "settings.json"), parseSettings) ?? { ...DEFAULT_SETTINGS };
    const devices = read(path.join(directory, "devices.json"), parseDevices);
    this.idSaved = !!devices;
    this.state = devices ?? { serverId: randomUUID(), devices: [] };
  }
  get serverId(): string { return this.state.serverId; }
  get devices(): readonly LinkDevice[] { return this.state.devices; }
  device(id: string): LinkDevice | undefined { return this.state.devices.find(device => device.id === id); }
  /** Returns the same object when nothing changed. */
  change(change: Partial<Pick<Settings, "imageScale" | "port">>): Settings {
    const next = { ...this.settings, ...change, revision: this.settings.revision + 1 };
    if (next.imageScale === this.settings.imageScale && next.port === this.settings.port) return this.settings;
    if (this.settings.revision === Number.MAX_SAFE_INTEGER) throw new Error("Settings revision limit reached.");
    write(this.directory, "settings.json", next);
    return this.settings = next;
  }
  /** The ID a QR code names must survive a restart, so it is saved before first use. */
  ensureServerId(): void { if (!this.idSaved) this.saveDevices(this.state.devices); }
  saveDevice(device: LinkDevice): void { this.saveDevices([...this.state.devices.filter(other => other.id !== device.id), device]); }
  removeDevice(id: string): boolean {
    if (!this.device(id)) return false;
    this.saveDevices(this.state.devices.filter(device => device.id !== id));
    return true;
  }
  private saveDevices(devices: LinkDevice[]): void {
    write(this.directory, "devices.json", { serverId: this.state.serverId,
      devices: devices.map(device => ({ ...device, key: device.key.toString("base64url") })) });
    this.state = { serverId: this.state.serverId, devices };
    this.idSaved = true;
  }
}
