import { SHEET_SIZE, type Rect } from "./protocol.ts";

/** Two coordinate systems. The iPad and the wire use SHEET coordinates: a
 * 4000 x 4000 point canvas with the origin at its top-left corner. The window
 * uses WORLD coordinates like Drawing Pad: the origin is the centre of the
 * question picture, or the sheet centre when there is none. */
export interface Offset { x: number; y: number }
export type Bounds = Rect;
/** Distance from the top of the sheet to the top of the question picture. */
export const REFERENCE_TOP = 200;
/** Distance from the top of the pad to the question picture; clears the toolbar. */
export const VIEW_TOP = 64;

/** Where the world origin sits on the sheet. */
export function sheetOrigin(referenceHeight: number): Offset {
  return { x: SHEET_SIZE / 2, y: referenceHeight > 0 ? REFERENCE_TOP + referenceHeight / 2 : SHEET_SIZE / 2 };
}
export function referenceOnSheet(width: number, height: number): Rect {
  return { x: (SHEET_SIZE - width) / 2, y: REFERENCE_TOP, width, height };
}
export function toWorld<T extends Offset>(value: T, referenceHeight: number): T {
  const origin = sheetOrigin(referenceHeight);
  return { ...value, x: value.x - origin.x, y: value.y - origin.y };
}
export function referenceBounds(width: number, height: number): Bounds {
  return { x: -width / 2, y: -height / 2, width, height };
}
/** A camera translation, never a scale. The question picture sits at the top
 * centre, because on the iPad you write below it; blank sheets are centred. */
export function viewOrigin(width: number, height: number, pan: Offset, referenceHeight = 0): Offset {
  return { x: width / 2 + pan.x, y: (referenceHeight > 0 ? VIEW_TOP + referenceHeight / 2 : height / 2) + pan.y };
}
/** Bound only the export raster, never world geometry or the display camera. */
export function exportRaster(bounds: Bounds, pixelRatio: number, imageScale: number): { width: number; height: number } {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, pixelRatio, imageScale].every(Number.isFinite) ||
    bounds.width <= 0 || bounds.height <= 0 || pixelRatio <= 0 || imageScale <= 0 || imageScale > 100) throw new Error("The drawing bounds cannot be exported. Your drawing has been kept.");
  const scale = Math.min(pixelRatio * imageScale / 100, 2000 / bounds.width, 2000 / bounds.height);
  return { width: Math.max(1, Math.min(2000, Math.round(bounds.width * scale))),
    height: Math.max(1, Math.min(2000, Math.round(bounds.height * scale))) };
}
/** The question picture and the ink together, plus a margin. World coordinates.
 * Independent of camera and viewport. */
export function exportBounds(width: number, height: number, ink: Bounds, padding = 24): Bounds {
  const reference = referenceBounds(width, height), hasReference = width > 0 && height > 0;
  const x = Math.floor(Math.min(ink.x, hasReference ? reference.x : ink.x) - padding);
  const y = Math.floor(Math.min(ink.y, hasReference ? reference.y : ink.y) - padding);
  const right = Math.ceil(Math.max(ink.x + ink.width, hasReference ? reference.x + width : ink.x + ink.width) + padding);
  const bottom = Math.ceil(Math.max(ink.y + ink.height, hasReference ? reference.y + height : ink.y + ink.height) + padding);
  return { x, y, width: right - x, height: bottom - y };
}
