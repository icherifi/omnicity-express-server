/**
 * Programmatically decides which original scanned objects stay (fixed/
 * structural equipment Claude should never touch) vs. get removed entirely
 * before Claude ever sees the scan (replaced instead by each zone's manifest -
 * see roomManifests.ts). Runs AFTER zone classification (roomZoningService.ts),
 * not before - see the `storage` handling below for why.
 */

import { DetectedObject } from "../types/staging.types";
import { Zone } from "./roomShellService";

/** Fixed/structural - never stripped, never a placement target, regardless of
 * zone. */
export const FIXED_EQUIPMENT_CATEGORIES = new Set([
  "bathtub",
  "toilet",
  "oven",
  "stove",
  "sink",
  "refrigerator",
  "washerDryer",
  "dishwasher",
  "fireplace",
  "stairs",
]);

/** RoomPlan's own `attributes.StorageType` is "cabinet" for both a bedroom
 * wardrobe and a real built-in kitchen base unit - not a reliable signal
 * either way. Zone location is the only distinguishing signal available -
 * kept only in kitchen/bathroom zones, stripped everywhere else. */
const STORAGE_KEPT_ZONE_LABELS = new Set(["kitchen", "bathroom"]);

export function stripFurniture(
  objects: DetectedObject[],
  zones: Zone[],
  objectZoneAssignments: Map<string, string>
): { kept: DetectedObject[]; stripped: DetectedObject[] } {
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const kept: DetectedObject[] = [];
  const stripped: DetectedObject[] = [];

  for (const obj of objects) {
    let isKept = FIXED_EQUIPMENT_CATEGORIES.has(obj.guessed_category);
    if (!isKept && obj.guessed_category === "storage") {
      const zoneId = objectZoneAssignments.get(obj.object_name);
      const zone = zoneId ? zoneById.get(zoneId) : undefined;
      isKept = !!zone && STORAGE_KEPT_ZONE_LABELS.has(zone.label);
    }
    (isKept ? kept : stripped).push(obj);
  }

  return { kept, stripped };
}
