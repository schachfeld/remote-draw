import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activateWith, type Dependencies } from "../src/backend.ts";

export async function until(condition: () => boolean, what = "condition", timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A 1x1 transparent PNG. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const WINDOW_A = "window-aaaa", WINDOW_B = "window-bbbb";
export const sheet = (id: string, extra: Record<string, unknown> = {}) => ({ id, theme: "dark", backgroundColor: "#101010", ...extra });

export function fixture(overrides: Partial<Dependencies> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-draw-test-"));
  const directory = path.join(root, "data"), controller = new AbortController();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const events: { topic: string; data: any }[] = [], advertised: { name: string; port: number; serverId: string }[] = [];
  let clock = 1_000_000, stops = 0, off: (() => Promise<void>) | undefined;
  const ctx = { dataDirectory: directory, signal: controller.signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    events: { emit(topic: string, data: unknown) { events.push({ topic, data }); } },
  } as unknown as PluginBackendContext;
  const deps: Dependencies = {
    advertise(options) { advertised.push({ name: options.name, port: options.port, serverId: options.serverId }); return { stop() { stops++; } }; },
    hostname: () => "test-mac", addresses: () => ["192.0.2.10", "100.64.0.7"], now: () => clock,
    link: { host: "127.0.0.1" }, sweepMs: 10, ...overrides,
  };
  const self = {
    directory, events, advertised, controller, handlers,
    get stops() { return stops; },
    advance(ms: number) { clock += ms; },
    /** Uses a random high port unless a settings file already exists. */
    async start() {
      if (!fs.existsSync(path.join(directory, "settings.json"))) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ revision: 0, imageScale: 50, port: 20000 + Math.floor(Math.random() * 20000) }));
      }
      off = await activateWith(ctx, deps);
    },
    call(name: string, input?: unknown): any { const handler = handlers.get(name); if (!handler) throw new Error(`No handler ${name}`); return handler(input); },
    async url(): Promise<string> { return `ws://127.0.0.1:${(await self.call("get-status")).port}/remote-draw/v1`; },
    topic(topic: string) { return events.filter(event => event.topic === topic).map(event => event.data); },
    async stop() { await off?.(); off = undefined; },
    async close() { await off?.(); fs.rmSync(root, { recursive: true, force: true }); },
  };
  return self;
}
