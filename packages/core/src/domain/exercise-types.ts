// Exercise measurement types (Hevy-parity plan §B/§C). The type decides which
// logging columns an exercise shows and how volume + records are computed.
// Immutable once sets exist (app-enforced); duplicate-as-custom is the reset.

export const EXERCISE_TYPES = [
  "weight_reps",
  "bodyweight_reps",
  "weighted_bodyweight",
  "assisted_bodyweight",
  "duration",
  "weight_duration",
  "distance_duration",
  "weight_distance",
] as const;

export type ExerciseType = (typeof EXERCISE_TYPES)[number];

export const EXERCISE_TYPE_LABELS: Record<ExerciseType, string> = {
  weight_reps: "Weight & reps",
  bodyweight_reps: "Bodyweight reps",
  weighted_bodyweight: "Weighted bodyweight",
  assisted_bodyweight: "Assisted bodyweight",
  duration: "Duration",
  weight_duration: "Weight & duration",
  distance_duration: "Distance & duration",
  weight_distance: "Weight & distance",
};

// Which set-log fields a type uses. `weight` semantics vary by type — see
// weightLabel below (added weight vs assistance vs plain load).
export type TypeFields = {
  weight: boolean;
  reps: boolean;
  duration: boolean;
  distance: boolean;
};

export const TYPE_FIELDS: Record<ExerciseType, TypeFields> = {
  weight_reps: { weight: true, reps: true, duration: false, distance: false },
  bodyweight_reps: {
    weight: false,
    reps: true,
    duration: false,
    distance: false,
  },
  weighted_bodyweight: {
    weight: true,
    reps: true,
    duration: false,
    distance: false,
  },
  assisted_bodyweight: {
    weight: true,
    reps: true,
    duration: false,
    distance: false,
  },
  duration: { weight: false, reps: false, duration: true, distance: false },
  weight_duration: {
    weight: true,
    reps: false,
    duration: true,
    distance: false,
  },
  distance_duration: {
    weight: false,
    reps: false,
    duration: true,
    distance: true,
  },
  weight_distance: {
    weight: true,
    reps: false,
    duration: false,
    distance: true,
  },
};

// Column header for the weight field, reflecting its per-type meaning.
export function weightLabel(type: ExerciseType, unit: string): string {
  if (type === "weighted_bodyweight") return `+${unit}`;
  if (type === "assisted_bodyweight") return `-${unit}`;
  return unit;
}

// Rep-based types allow RPE/RIR effort logging; duration-only ones don't.
export function supportsEffort(type: ExerciseType): boolean {
  return TYPE_FIELDS[type].reps;
}

export function isDurationType(type: ExerciseType): boolean {
  return TYPE_FIELDS[type].duration;
}

// A set is loggable when every field the type uses has a value (reps must be
// ≥1 — zero-rep sets are rejected; failure sets log the last completed rep).
export function isCompletableSet(
  type: ExerciseType,
  set: {
    weightKg?: number | null;
    reps?: number | null;
    durationSec?: number | null;
    distanceM?: number | null;
  },
): boolean {
  const f = TYPE_FIELDS[type];
  if (f.reps && !(set.reps != null && set.reps >= 1)) return false;
  if (f.duration && !(set.durationSec != null && set.durationSec > 0))
    return false;
  if (f.distance && !(set.distanceM != null && set.distanceM > 0)) return false;
  // Weight may legitimately be 0 (empty bar handled upstream, assistance 0),
  // but must be present for weight-bearing types.
  if (f.weight && set.weightKg == null) return false;
  return true;
}

// Gimmick kinds (kettlebell/band/suspension) were removed 2026-08-08 — the
// picker side of the 2026-08-07 gimmick-exercise purge (docs/DECISIONS.md):
// the captain's call that bands, kettlebells, balls, ropes and similar
// novelty equipment aren't real training apparatus for this app. The labels
// stay in EQUIPMENT_LABELS so exercises that predate the purge (user customs
// created while the options still existed) keep rendering their equipment
// instead of a blank — the kind is just no longer selectable or generator-usable.
export const EQUIPMENT_KINDS = [
  "barbell",
  "ez_bar",
  "dumbbell",
  "machine",
  "cable",
  "bodyweight",
  "plate",
  "other",
] as const;

export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

// Legacy display-only kinds, kept so pre-purge rows still resolve a label.
export type EquipmentDisplayKind =
  | EquipmentKind
  | "kettlebell"
  | "band"
  | "suspension";

export const EQUIPMENT_LABELS: Record<EquipmentDisplayKind, string> = {
  barbell: "Barbell",
  ez_bar: "EZ bar",
  dumbbell: "Dumbbell",
  kettlebell: "Kettlebell",
  machine: "Machine",
  cable: "Cable",
  band: "Band",
  suspension: "Suspension",
  bodyweight: "Bodyweight",
  plate: "Plate",
  other: "Other",
};

// Plate-calculator eligibility: bar-loaded equipment only (never dumbbells).
export function isBarLoaded(equipment: string | null | undefined): boolean {
  return equipment === "barbell" || equipment === "ez_bar";
}

// Compound vs isolation. Explicit field replacing the muscleTargets.length>=2
// proxy in generator/generate.ts — a one-primary custom exercise is no longer
// forced to "isolation" just for having a short muscle list.
export const MECHANICS = ["compound", "isolation"] as const;
export type Mechanic = (typeof MECHANICS)[number];
export const MECHANIC_LABELS: Record<Mechanic, string> = {
  compound: "Compound",
  isolation: "Isolation",
};

// Movement pattern — the taxonomy the push/pull/legs day templates in
// generator/generate.ts currently reconstruct from muscle keys. Chosen to
// line up with those templates: every pattern maps cleanly to push/pull/legs.
export const MOVEMENT_PATTERNS = [
  "horizontal-push",
  "vertical-push",
  "horizontal-pull",
  "vertical-pull",
  "squat",
  "hinge",
  "lunge",
  "carry",
  "rotation",
  "isolation",
] as const;
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];
export const MOVEMENT_PATTERN_LABELS: Record<MovementPattern, string> = {
  "horizontal-push": "Horizontal push",
  "vertical-push": "Vertical push",
  "horizontal-pull": "Horizontal pull",
  "vertical-pull": "Vertical pull",
  squat: "Squat",
  hinge: "Hinge",
  lunge: "Lunge",
  carry: "Carry",
  rotation: "Rotation",
  isolation: "Isolation",
};

// Bilateral vs unilateral (2026-08-08, UI feedback note 5: alternating is
// gone, folded into bilateral — a DB row that still stores 'alternating'
// reads as bilateral everywhere). Decides whether logged reps mean per-side
// or total, and therefore per-side volume + PR comparability. Display names
// are the unilateral/bilateral vocabulary the captain asked for (2026-08-08,
// UI feedback note 15) — "sides" is not a UI word anymore.
export const LATERALITY = ["bilateral", "unilateral"] as const;
export type Laterality = (typeof LATERALITY)[number];
export const LATERALITY_LABELS: Record<Laterality, string> = {
  bilateral: "Bilateral",
  unilateral: "Unilateral",
};

// One-line explainers for the laterality menu, telling unilateral (each side
// does the reps separately — two logged rows) apart from bilateral (one row
// for the whole set).
export const LATERALITY_EXPLAINERS: Record<Laterality, string> = {
  bilateral: "Both sides work together — one row per set.",
  unilateral: "One side at a time — each side's reps are logged separately.",
};

export const SET_TYPES = ["normal", "warmup", "failure", "drop"] as const;
export type SetType = (typeof SET_TYPES)[number];

// Marker letter shown in the set-number cell ('' = plain number).
export const SET_TYPE_MARKERS: Record<SetType, string> = {
  normal: "",
  warmup: "W",
  failure: "F",
  drop: "D",
};

export const SET_TYPE_LABELS: Record<SetType, string> = {
  normal: "Normal",
  warmup: "Warm-up",
  failure: "Failure",
  drop: "Drop set",
};
