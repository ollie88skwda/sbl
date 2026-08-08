import { MUSCLE_REGION_LABELS, type MuscleRegion } from "@frog/core";
import { useState } from "react";
import Model, { type IExerciseData, type Muscle } from "react-body-highlighter";
import { REGION_ORDER, regionSetsOf } from "./body-paths";

// Human-body heat map (stats hub, M8) — the FIGURE is a standard anterior +
// posterior human body from the react-body-highlighter library (MIT), not a
// hand-authored schematic (docs/DECISIONS.md 2026-08-08, stats-screen batch:
// note 5 supersedes the frog-themed figure for the stats screen). Only the
// roll-up (23-muscle vocabulary → 6 coarse regions) and the chips/readout are
// ours, reusing the one shared body-paths module's region mapping so stats and
// the share-card painter can't disagree about what a set counts as.
//
// Encoding stays the old one: each region's set count scales the accent fill
// intensity (faint → full accent over 5 steps), unworked regions read as a
// neutral silhouette. The library keys colors off a per-exercise `frequency`
// (highlightedColors[frequency-1]), so each region's bucketed count rides in
// as the frequency of one synthetic "exercise" covering that region's muscles.

const INTENSITY_STEPS = 5;

// 5-step accent ramp, blended toward the page background — the old
// opacity-over-accent encoding, theme-safe in light + dark (--bg flips with
// the theme via theme.css, like every other Radix-token fill).
const PALETTE = Array.from({ length: INTENSITY_STEPS }, (_, i) => {
  const pct = 18 + Math.round((82 * i) / (INTENSITY_STEPS - 1));
  return `color-mix(in srgb, var(--accent) ${pct}%, var(--bg))`;
});

const BODY_COLOR = "var(--surface-3)";

// Region → the library's named muscles. Disjoint by construction (a library
// muscle belongs to exactly one region), so each region's frequency lands on
// its muscles exactly once — no double-counting in the library's aggregation.
const REGION_MUSCLES: Record<MuscleRegion, Muscle[]> = {
  chest: ["chest"],
  back: ["trapezius", "upper-back", "lower-back"],
  legs: [
    "quadriceps",
    "hamstring",
    "calves",
    "gluteal",
    "adductor",
    "abductors",
  ],
  shoulders: ["front-deltoids", "back-deltoids"],
  arms: ["biceps", "triceps", "forearm"],
  core: ["abs", "obliques"],
};

const MUSCLE_TO_REGION: ReadonlyMap<Muscle, MuscleRegion> = new Map(
  (Object.entries(REGION_MUSCLES) as [MuscleRegion, Muscle[]][]).flatMap(
    ([region, muscles]) => muscles.map((m) => [m, region] as const),
  ),
);

function Figure({
  view,
  data,
  onSelect,
}: {
  view: "anterior" | "posterior";
  data: IExerciseData[];
  /** Region-tap handler; absent = non-interactive figure. */
  onSelect?: (m: Muscle) => void;
}) {
  return (
    <div>
      <Model
        type={view}
        data={data}
        bodyColor={BODY_COLOR}
        highlightedColors={PALETTE}
        onClick={onSelect ? (stats) => onSelect(stats.muscle) : undefined}
        style={{ width: "100%", aspectRatio: "100 / 200" }}
        svgStyle={{ display: "block" }}
      />
      <p className="mt-1 text-center text-2xs text-faint">
        {view === "anterior" ? "Front" : "Back"}
      </p>
    </div>
  );
}

export function HumanBodyHeatmap({
  muscleSets,
  max: maxProp,
  interactive = true,
  className,
  testId,
}: {
  muscleSets: Record<string, number>;
  /** Explicit intensity ceiling; defaults to the busiest region. */
  max?: number;
  /** Selection chips + tap-to-select regions (default true). Off for the
   *  Home teaser, where the card is small and the figures are a glanceable
   *  preview, not a control (docs/DECISIONS.md 2026-08-08, Routines-tab &
   *  Home-heatmap entry). */
  interactive?: boolean;
  className?: string;
  testId?: string;
}) {
  const [selected, setSelected] = useState<MuscleRegion | null>(null);
  const regionSets = regionSetsOf(muscleSets);
  const max = maxProp ?? Math.max(1, ...Object.values(regionSets));

  // Bucket a region's set count to 1..5 (0 = untouched). Relative to the
  // busiest region, so one set on a quiet day still reads as intensity and
  // the top region always reaches the full accent.
  const freq = (n: number) =>
    n <= 0 ? 0 : Math.max(1, Math.round((n / max) * INTENSITY_STEPS));

  const data: IExerciseData[] = (
    Object.entries(REGION_MUSCLES) as [MuscleRegion, Muscle[]][]
  )
    .filter(([region]) => regionSets[region] > 0)
    .map(([region, muscles]) => ({
      name: region,
      muscles,
      frequency: freq(regionSets[region]),
    }));

  const selectedValue = selected ? regionSets[selected] : null;

  const select = (m: Muscle) => {
    const r = MUSCLE_TO_REGION.get(m);
    if (r) setSelected(r);
  };

  return (
    <div className={className} data-testid={testId}>
      <div className="grid grid-cols-2 gap-3">
        <Figure
          view="anterior"
          data={data}
          onSelect={interactive ? select : undefined}
        />
        <Figure
          view="posterior"
          data={data}
          onSelect={interactive ? select : undefined}
        />
      </div>
      {interactive && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {REGION_ORDER.map((region) => {
            const isSel = selected === region;
            return (
              <button
                key={region}
                type="button"
                onClick={() => setSelected(region)}
                className={
                  isSel
                    ? "num h-7 bg-accent-soft px-2 text-2xs text-accent"
                    : "num h-7 bg-translucent px-2 text-2xs text-soft transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
                }
                data-testid={`heatmap-chip-${region}`}
              >
                {MUSCLE_REGION_LABELS[region]}{" "}
                <span className="text-faint">
                  {formatSets(regionSets[region])}
                </span>
              </button>
            );
          })}
          {selected && (
            <span
              className="num ml-auto text-2xs text-soft"
              data-testid="heatmap-readout"
            >
              {MUSCLE_REGION_LABELS[selected]} ·{" "}
              {formatSets(selectedValue ?? 0)} sets
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Fractional set counts (primary 1.0 / secondary 0.5) — show the ".5" only when
// present so whole counts stay clean.
function formatSets(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
