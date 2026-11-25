/** Shared by the window and the background service; no Node imports here. */
export const DEFAULT_IMAGE_SCALE = 50;
export interface Settings { revision: number; imageScale: number; port: number }
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
export function parseSettings(value: unknown): Settings {
  const input = record(value, "Remote Draw settings");
  if (Object.keys(input).some(key => !["revision", "imageScale", "port"].includes(key))) throw new Error("Invalid Remote Draw settings.");
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
