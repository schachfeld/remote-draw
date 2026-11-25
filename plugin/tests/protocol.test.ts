import assert from "node:assert/strict";
import { it } from "node:test";
import { createHmac } from "node:crypto";
import { deviceKey, proof, proofMatches } from "../src/auth.ts";
import { ProtocolError, parseClientMessage, parseSheetState } from "../src/protocol.ts";
import { PNG } from "./helpers.ts";

const nonce = "abcdefghijklmnop", proofText = "A".repeat(43), device = "0f8fad5b-d9cb-469f-a165-70867728950e";
const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

it("computes the proofs exactly as the specification writes them", () => {
  const key = Buffer.alloc(32, 7), text = (purpose: string) => `remote-draw/v1/${purpose}\nS\nC\n${device}`;
  for (const purpose of ["pair", "auth", "server"] as const)
    assert.equal(proof(key, purpose, "S", "C", device), createHmac("sha256", key).update(text(purpose)).digest("base64url"));
  assert.deepEqual(deviceKey(key, "S", "C", device), createHmac("sha256", key).update(text("key")).digest());
  assert.equal(proof(key, "pair", "S", "C", device).length, 43);
  assert.notEqual(proof(key, "auth", "S", "C", device), proof(key, "server", "S", "C", device));
  assert.ok(proofMatches("abc", "abc")); assert.ok(!proofMatches("abc", "abd")); assert.ok(!proofMatches("abc", "abcd"));
});
it("accepts well-formed handshake messages and drops unknown fields", () => {
  assert.deepEqual(parse({ type: "pair", deviceId: device, deviceName: "  My iPad ", nonce, proof: proofText, extra: 1 }),
    { type: "pair", deviceId: device, deviceName: "My iPad", nonce, proof: proofText });
  assert.deepEqual(parse({ type: "auth", deviceId: device, nonce, proof: proofText }), { type: "auth", deviceId: device, nonce, proof: proofText });
});
it("rejects malformed handshake messages", () => {
  const pair = { type: "pair", deviceId: device, deviceName: "iPad", nonce, proof: proofText };
  for (const change of [{ deviceId: "short" }, { deviceId: "has space-xxxxxxxx" }, { deviceName: "" }, { deviceName: "  " }, { deviceName: "x".repeat(65) },
    { nonce: "tooshort" }, { nonce: "bad+chars/abcdefgh" }, { proof: "A".repeat(42) }, { proof: 1 }])
    assert.throws(() => parse({ ...pair, ...change }), ProtocolError, JSON.stringify(change));
  for (const raw of ["", "nope", "[]", "null", "1", JSON.stringify({ type: "hello" }), JSON.stringify({})])
    assert.throws(() => parseClientMessage(raw), ProtocolError, raw);
});
it("validates preview messages", () => {
  const preview = { type: "preview", sheet: "s-1", stroke: 1, color: "#FFAA00", width: 3, points: [[1, 2], [3.5, -4]], end: false };
  assert.deepEqual(parse(preview), { ...preview, color: "#ffaa00" });
  assert.deepEqual((parse({ ...preview, points: [], end: true }) as { points: unknown[] }).points, []);
  for (const change of [{ sheet: "" }, { sheet: "a b" }, { stroke: 0 }, { stroke: 1.5 }, { color: "red" }, { width: 0 }, { width: 101 }, { width: NaN },
    { points: [[1]] }, { points: [[1, 2, 3]] }, { points: [[1, "2"]] }, { points: [[1, Infinity]] }, { points: "x" },
    { points: Array.from({ length: 513 }, () => [0, 0]) }, { end: "yes" }])
    assert.throws(() => parse({ ...preview, ...change }), ProtocolError, JSON.stringify(change).slice(0, 60));
});
it("validates ink messages and their PNG", () => {
  const ink = { type: "ink", sheet: "s-1", through: 0, theme: "light", drawing: "AAEC", image: { x: 1, y: 2, width: 3, height: 4, png: PNG } };
  assert.deepEqual(parse(ink), ink);
  const { image: _image, ...empty } = ink;
  assert.deepEqual(parse(empty), empty);
  for (const change of [{ through: -1 }, { through: 1.5 }, { theme: "sepia" }, { drawing: "" }, { drawing: "not base64!" },
    { image: { x: 1, y: 2, width: 0, height: 4, png: PNG } }, { image: { x: 1, y: 2, width: 3, height: -4, png: PNG } },
    { image: { x: 1, y: 2, width: 3, height: 4, png: "AAEC" } }, { image: { x: "1", y: 2, width: 3, height: 4, png: PNG } }, { image: [] }])
    assert.throws(() => parse({ ...ink, ...change }), ProtocolError, JSON.stringify(change).slice(0, 60));
});
it("validates the sheet a window opens", () => {
  const sheet = { id: "s-1", theme: "dark", backgroundColor: "#101010" };
  assert.deepEqual(parseSheetState({ ...sheet, junk: true }), sheet);
  const full = { ...sheet, reference: { x: 0, y: 0, width: 10, height: 10, png: PNG }, drawing: "AAEC" };
  assert.deepEqual(parseSheetState(full), full);
  for (const change of [{ id: "" }, { theme: "x" }, { backgroundColor: "black" }, { reference: { x: 0, y: 0, width: 10, height: 10, png: "AAEC" } }, { drawing: "" }])
    assert.throws(() => parseSheetState({ ...sheet, ...change }), ProtocolError);
  for (const value of [null, [], "s"]) assert.throws(() => parseSheetState(value), ProtocolError);
});
