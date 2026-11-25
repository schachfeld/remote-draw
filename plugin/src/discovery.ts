import { Bonjour } from "bonjour-service";
import { PROTOCOL_VERSION, SERVICE_TYPE } from "./protocol.ts";

export interface Advertisement { stop(): void }
export type Advertise = (options: { name: string; port: number; serverId: string; failed(message: string): void }) => Advertisement;

/** Bonjour is a convenience: the iPad also keeps the addresses from the QR code.
 * A failure is reported, never thrown. */
export const advertise: Advertise = ({ name, port, serverId, failed }) => {
  let bonjour: Bonjour | undefined;
  try {
    bonjour = new Bonjour(undefined, (error: unknown) => failed(error instanceof Error ? error.message : String(error)));
    const service = bonjour.publish({ name, type: SERVICE_TYPE, port, txt: { v: String(PROTOCOL_VERSION), id: serverId } });
    service.on("error", (error: unknown) => failed(error instanceof Error ? error.message : String(error)));
  } catch (error) { failed(error instanceof Error ? error.message : String(error)); }
  return { stop() {
    const instance = bonjour;
    bonjour = undefined;
    if (!instance) return;
    try { instance.unpublishAll(() => { try { instance.destroy(); } catch { /* Already closed. */ } }); }
    catch { /* Already closed. */ }
  } };
};
