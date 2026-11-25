import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type Purpose = "pair" | "key" | "auth" | "server";
function mac(key: Buffer, purpose: Purpose, serverNonce: string, clientNonce: string, deviceId: string): Buffer {
  return createHmac("sha256", key).update(`remote-draw/v1/${purpose}\n${serverNonce}\n${clientNonce}\n${deviceId}`, "utf8").digest();
}
export function newNonce(): string { return randomBytes(24).toString("base64url"); }
export function newPairingCode(): Buffer { return randomBytes(32); }
export function proof(key: Buffer, purpose: Exclude<Purpose, "key">, serverNonce: string, clientNonce: string, deviceId: string): string {
  return mac(key, purpose, serverNonce, clientNonce, deviceId).toString("base64url");
}
export function deviceKey(code: Buffer, serverNonce: string, clientNonce: string, deviceId: string): Buffer {
  return mac(code, "key", serverNonce, clientNonce, deviceId);
}
export function proofMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
