/**
 * Pre-established furniture lists per room archetype - the deterministic
 * replacement for Claude choosing which IKEA product to use. Every item_no here
 * was picked via a one-time search against IKEA's real catalog (see git history
 * for scripts/research-manifest-items.ts, since deleted - throwaway) and
 * confirmed to download/measure to a sane, non-degenerate bounding box through
 * the same ikeaService/glbGeometryService pipeline every placement already uses.
 *
 * Claude's only remaining decision per slot is WHERE (which wall, which corner,
 * which existing item to sit relative to) - never WHAT. anchor_category is a
 * quick human/Claude-readable label ("independent" - against_wall/in_corner/
 * room_center/zone_center, depends on nothing; "dependent" -
 * relative_to/facing_target_wall, targets another slot); the orchestrator's
 * ACTUAL phase ordering is computed from depends_on_slot_id's dependency
 * graph (see stagingOrchestratorService.ts's computeSlotDepths), not from
 * this field, so a multi-level chain (a slot depending on a slot that itself
 * depends on something) still gets ordered correctly even though it's still
 * just "dependent" here.
 */

import { PlacementAnchor } from "../types/staging.types";
import { Zone } from "../services/roomShellService";

export type AnchorCategory = "independent" | "dependent";

export interface ManifestSlot {
  /** Unique within one archetype's manifest - gets zone-id-prefixed by
   * selectAndFlattenManifests() into a run-scoped slot_id. */
  slot_id: string;
  category: string;
  /** IKEA item number (model_source "ikea", the default) or a key into
   * localModelService.ts's registry (model_source "local") - for items IKEA
   * doesn't sell at all (a real TV, for example - IKEA has no TV SKU). Either
   * way this is resolved server-side; Claude never sees or chooses it. */
  item_no: string;
  model_source?: "ikea" | "local";
  anchor_category: AnchorCategory;
  allowed_anchor_kinds: PlacementAnchor["kind"][];
  /** For a "dependent" slot only: the (unprefixed) slot_id within this same
   * manifest it's positioned relative to (relative_to/facing_target_wall's
   * target_id). Lets the orchestrator pre-abandon a dependent slot once its
   * target fails, and compute dependency depth for phase ordering - a
   * multi-level chain (media_console -> tv/sofa -> coffee_table) gets one
   * ordered phase per level instead of colliding in one "dependent" bucket. */
  depends_on_slot_id?: string;
  /** Overrides whatever `facing` Claude supplies (or fills it in if omitted)
   * for slots where the correct orientation is knowable in advance.
   * "toward_depends_on_target" = face the slot named by depends_on_slot_id
   * (e.g. a chair facing its table). "anchor_default" = strip facing entirely
   * so the anchor's own deterministic default wins (e.g. zone_center's
   * wall-parallel rotation), for a slot with no context-dependent judgment
   * call for Claude to legitimately make differently. */
  forced_facing?: "toward_depends_on_target" | "anchor_default";
  /** Overrides a relative_to intent's `align` the same way forced_facing
   * overrides `facing` - e.g. a coffee table in_front_of the sofa must be
   * centered on it (align:"center"), not at whichever edge Claude happens to
   * pick, to stay on the same visual axis as the media console/TV behind it. */
  forced_align?: "center";
  /** Fully overrides a relative_to anchor's relation/align/gap_cm (target_id
   * still from depends_on_slot_id) - for a slot where the ENTIRE relative
   * placement is knowable in advance, not just facing or alignment (e.g. each
   * dining chair always on the same table edge, centered, tucked slightly
   * under - see allowedOverlapTargetId in layoutValidationService.ts for why
   * that overlap isn't a violation). Never set together with forced_align -
   * this already subsumes it. */
  forced_relative_to?: { relation: "left_of" | "right_of" | "in_front_of" | "behind"; align?: "center" | "start" | "end"; gap_cm?: number };
  notes?: string;
}

export interface RoomManifest {
  archetype_id: string;
  label: string;
  slots: ManifestSlot[];
}

export interface FlattenedSlot extends ManifestSlot {
  /** Zone-prefixed, globally unique across this run's whole manifest (e.g.
   * "zone_bedroom_1__wardrobe" vs "zone_bedroom_2__wardrobe"). */
  slot_id: string;
  /** Which zone this slot belongs to - needed for zone_center anchors, and as
   * general context for the system prompt. */
  zone_id: string;
}

// --- Archetype content -------------------------------------------------------

const BEDROOM: RoomManifest = {
  archetype_id: "bedroom",
  label: "Chambre",
  slots: [
    {
      slot_id: "bed",
      category: "queen_bed",
      item_no: "60573251", // TUFJORD, 180x110x224cm
      anchor_category: "independent",
      allowed_anchor_kinds: ["against_wall"],
      notes: "Tête de lit contre le mur le plus long de la chambre.",
    },
    {
      slot_id: "wardrobe",
      category: "large_wardrobe",
      item_no: "40407922", // BRIMNES, 117x194x53cm
      anchor_category: "independent",
      allowed_anchor_kinds: ["against_wall", "in_corner"],
    },
    {
      slot_id: "nightstand_left",
      category: "nightstand",
      item_no: "10234942", // BRIMNES, 39x53x44cm
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "bed",
      notes: "relative_to le slot \"bed\", relation left_of.",
    },
    {
      slot_id: "nightstand_right",
      category: "nightstand",
      item_no: "10234942", // BRIMNES, 39x53x44cm
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "bed",
      notes: "relative_to le slot \"bed\", relation right_of.",
    },
  ],
};

const LIVING_ROOM: RoomManifest = {
  archetype_id: "living_room",
  label: "Salon",
  slots: [
    {
      // The TV console is independent (against_wall) rather than
      // facing_target_wall("sofa"): Claude can pick among whichever walls are
      // actually free and retry a different one on failure, unlike
      // facing_target_wall which computes one fixed wall with no alternative
      // to try if it's too narrow/fragmented.
      slot_id: "media_console",
      category: "tv_bench",
      item_no: "00474070", // BESTÅ, 180x39x40cm
      anchor_category: "independent",
      allowed_anchor_kinds: ["against_wall"],
      // anchor_default: against_wall's own default (face into the room, away
      // from the wall) is always correct for a TV bench - nothing should be
      // allowed to override it, same reasoning as dining_table's rotation.
      forced_facing: "anchor_default",
      notes: "against_wall - Claude choisit le mur, comme pour n'importe quel meuble indépendant.",
    },
    {
      // Depends on the CONSOLE now, not the other way around - the sofa faces
      // the TV, not the reverse, so it's placed once the console's wall is
      // known. No longer assumed to be against its own wall (a sofa facing a
      // TV across an open room is completely normal).
      slot_id: "sofa",
      category: "3_seat_sofa",
      item_no: "69509010", // EKTORP, 219x91x93cm
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "media_console",
      // anchor_default: in_front_of's own default facing is already
      // "toward_target" (dirToYaw(neg(console's forward)) - since the console
      // faces away from its wall, this points the sofa straight back at it) -
      // always correct, so locked the same way as every other slot whose
      // anchor default needs no Claude judgment call.
      forced_facing: "anchor_default",
      // gap_cm deliberately left to Claude, unlike the dining chairs - the
      // right TV-viewing distance depends on how much room is available.
      // Omitting it falls through to a tiny default meant only to dodge a
      // collision-detection edge case, not a real distance - must be explicit.
      notes:
        "relative_to le slot \"media_console\", relation in_front_of - face à la télé, pas nécessairement contre un mur. Précise TOUJOURS un gap_cm explicite (150-250cm selon la place disponible dans la zone) pour une vraie distance de visionnage - ne JAMAIS l'omettre ici, contrairement à against_wall.",
    },
    {
      // No forced_facing here (unlike the dining chairs below): on_top_of's
      // own default facing is already "match_target" (face the same way the
      // console faces) - correct as-is. Forcing "toward_depends_on_target"
      // would be a real bug: the TV sits centered directly above the console
      // (same X/Z), so "face toward the console" would compute a direction
      // from a point to itself - degenerate/meaningless.
      slot_id: "tv",
      category: "television",
      // TV_TCL_50_INCHES, 111x65x26.5cm - swapped from mi_smart_tv
      // (200x131.6x39.7cm, an oversized ~85" panel) for a realistic 50" size.
      // Already authored origin-at-base/XZ-centered on its own - onboarded
      // via onboard-local-model.ts's new raw-.glb input path (no OBJ/MTL
      // conversion needed, just the same recenter/measure/upload treatment).
      item_no: "tv_tcl_50",
      model_source: "local",
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "media_console",
      notes: "relative_to le slot \"media_console\", relation on_top_of - se pose directement sur le meuble télé.",
    },
    {
      slot_id: "armchair",
      category: "armchair",
      item_no: "70392542", // STRANDMON, 59x71x65cm
      anchor_category: "independent",
      allowed_anchor_kinds: ["against_wall", "room_center"],
    },
    {
      slot_id: "coffee_table",
      category: "coffee_table",
      // BORGEBY, 70x42x70cm - sized between a too-small 55cm option and the
      // original 90cm TRANERED. Kept square rather than a rectangular
      // alternative: a rectangular model's authored width vs depth axis isn't
      // verified to match its visual long side, risking a 90°-rotated look.
      item_no: "70389356",
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "sofa",
      // forced_align "center": in_front_of's default (align omitted) is
      // EDGE-aligned, not centered - without this the coffee table would sit
      // flush with one arm of the sofa instead of centered on it, breaking
      // the shared sofa/coffee-table/console/TV axis.
      forced_align: "center",
      // gap_cm guidance, same reasoning as the sofa slot above - 35-45cm is
      // the standard comfortable-legroom gap between a sofa and coffee table.
      notes:
        "relative_to le slot \"sofa\", relation in_front_of. Précise TOUJOURS un gap_cm explicite (35-45cm, dégagement confortable devant le canapé) - ne JAMAIS l'omettre.",
    },
  ],
};

/** For a zone too small to fit a 3-seat sofa + TV bench without violating
 * door/window/floor-shape clearances. Just the armchair, which fits even in a
 * small zone. */
const LIVING_ROOM_COMPACT: RoomManifest = {
  archetype_id: "living_room_compact",
  label: "Petit salon",
  slots: LIVING_ROOM.slots.filter((s) => s.slot_id === "armchair"),
};

/** How far a dining chair tucks under the table (negative = real overlap, not
 * just a zero gap) - matches how far a real chair slides under a table's
 * apron. At -15cm, the resulting overlap for this manifest's real table/chair
 * (LISABO 140x74x78cm / BERGMUND 53x96x61cm) is ≈0.06 m³, comfortably under
 * RELAXED_FURNITURE_OVERLAP_VOLUME_M3 (0.08 m³, layoutValidationService.ts)
 * while a fully-coincident placement bug (≈0.24 m³) still gets caught. */
const DINING_CHAIR_TUCK_GAP_CM = -15;

const LIVING_DINING: RoomManifest = {
  archetype_id: "living_dining",
  label: "Salon + salle à manger",
  slots: [
    ...LIVING_ROOM.slots,
    {
      slot_id: "dining_table",
      category: "dining_table_4to6",
      item_no: "70294339", // LISABO, 140x74x78cm
      anchor_category: "independent",
      allowed_anchor_kinds: ["zone_center"],
      // NOT forced_facing here, deliberately - unlike media_console (one
      // correct facing regardless of context), which wall-parallel
      // orientation best fits a table genuinely depends on the zone's shape,
      // so Claude keeps that judgment call (using bounds_min/bounds_max from
      // buildPromptZones). The default (no facing supplied) still falls back
      // to nearestWallRotation, so it's never an arbitrary tilt.
      notes:
        "Ancre zone_center sur ce slot's zone_id, avec sub_region \"half_b\" (la moitié la plus éloignée du centre de tout l'étage) pour occuper la partie salle à manger distincte du coin salon.",
    },
    // The 4 dining chairs are a fully deterministic block: one centered on
    // each table edge, facing the center, tucked slightly under it.
    // forced_relative_to overrides the whole anchor (relation/align/gap_cm) -
    // Claude only triggers the placement, never influences where it lands.
    // forced_facing is still needed alongside it since left_of/right_of's own
    // default ("match_target") would face the same way the table faces, not
    // toward it.
    {
      slot_id: "dining_chair_1",
      category: "dining_chair",
      item_no: "39388081", // BERGMUND, 53x96x61cm
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "dining_table",
      forced_facing: "toward_depends_on_target",
      forced_relative_to: { relation: "left_of", align: "center", gap_cm: DINING_CHAIR_TUCK_GAP_CM },
      notes: "relative_to le slot \"dining_table\", relation left_of.",
    },
    {
      slot_id: "dining_chair_2",
      category: "dining_chair",
      item_no: "39388081",
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "dining_table",
      forced_facing: "toward_depends_on_target",
      forced_relative_to: { relation: "right_of", align: "center", gap_cm: DINING_CHAIR_TUCK_GAP_CM },
      notes: "relative_to le slot \"dining_table\", relation right_of.",
    },
    {
      slot_id: "dining_chair_3",
      category: "dining_chair",
      item_no: "39388081",
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "dining_table",
      forced_facing: "toward_depends_on_target",
      forced_relative_to: { relation: "in_front_of", align: "center", gap_cm: DINING_CHAIR_TUCK_GAP_CM },
      notes: "relative_to le slot \"dining_table\", relation in_front_of.",
    },
    {
      slot_id: "dining_chair_4",
      category: "dining_chair",
      item_no: "39388081",
      anchor_category: "dependent",
      allowed_anchor_kinds: ["relative_to"],
      depends_on_slot_id: "dining_table",
      forced_facing: "toward_depends_on_target",
      forced_relative_to: { relation: "behind", align: "center", gap_cm: DINING_CHAIR_TUCK_GAP_CM },
      notes: "relative_to le slot \"dining_table\", relation behind.",
    },
  ],
};

const MANIFESTS_BY_ARCHETYPE: Record<string, RoomManifest> = {
  bedroom: BEDROOM,
  living_room_compact: LIVING_ROOM_COMPACT,
  living_room: LIVING_ROOM,
  living_dining: LIVING_DINING,
};

/** A "living"-labeled (or generic/unidentified) zone at or above this area
 * gets the combined living_dining archetype instead of plain living_room. */
const LIVING_DINING_AREA_THRESHOLD_M2 = 20;
/** Below this, even the plain living_room manifest's sofa/media_console don't
 * reliably fit - drop to LIVING_ROOM_COMPACT instead. */
const LIVING_ROOM_COMPACT_AREA_THRESHOLD_M2 = 10;

/** Zone labels that intentionally get no manifest at all - their existing fixed
 * equipment (see furnitureStrippingService.ts) is the whole point, not an
 * IKEA-furnished room. */
const NO_MANIFEST_LABELS = new Set(["kitchen", "bathroom"]);

function archetypeForZone(zone: Zone): RoomManifest | null {
  if (NO_MANIFEST_LABELS.has(zone.label)) return null;
  if (zone.label === "bedroom") return BEDROOM;
  // "living", "generic", and anything else unmapped all default to a living-
  // style manifest - deliberately, not an omission: an unidentified zone is
  // most commonly some kind of living/flex space in a real apartment, and
  // defaulting it to a furnished manifest (rather than skipping it) is what
  // makes a scan with zero sections/zero furniture still get furnished at all.
  if (zone.area_m2 >= LIVING_DINING_AREA_THRESHOLD_M2) return LIVING_DINING;
  if (zone.area_m2 >= LIVING_ROOM_COMPACT_AREA_THRESHOLD_M2) return LIVING_ROOM;
  return LIVING_ROOM_COMPACT;
}

export function selectAndFlattenManifests(zones: Zone[]): FlattenedSlot[] {
  const flattened: FlattenedSlot[] = [];
  for (const zone of zones) {
    const manifest = archetypeForZone(zone);
    if (!manifest) continue;
    for (const slot of manifest.slots) {
      flattened.push({
        ...slot,
        slot_id: `${zone.id}__${slot.slot_id}`,
        zone_id: zone.id,
        depends_on_slot_id: slot.depends_on_slot_id ? `${zone.id}__${slot.depends_on_slot_id}` : undefined,
      });
    }
  }
  return flattened;
}
