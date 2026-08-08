import { type GeneratedProgram, generateProgram } from "@frog/core";
import { ArrowLeft, Dumbbell } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  catalogEntry,
  EQUIPMENT_PROFILE_LABELS,
  type EquipmentProfile,
  entryConfig,
  equipmentProfile,
  GOAL_LABELS,
  LEVEL_LABELS,
  PROGRAM_CATALOG,
  type ProgramCatalogEntry,
  type ProgramGoal,
  type ProgramLevel,
} from "@/data/program-catalog";
import { useMaterializeProgram } from "@/lib/program-queries";
import { useExercisePrefs, useExercises } from "@/lib/queries";
import { selectableFrom } from "@/lib/trainer";
import { cn } from "@/lib/utils";
import { useVoice } from "@/lib/voice";

// Explore program library (Hevy-parity M11). The catalog is a set of generator
// configs + copy; the actual routines are materialized deterministically by
// generateProgram at save time, so this screen ships no exercise data. One
// component serves both the list (/programs) and a detail (/programs/:key).
export default function ProgramsScreen() {
  const { key } = useParams<{ key: string }>();
  if (key) return <ProgramDetail programKey={key} />;
  return <ProgramCatalog />;
}

function Chip({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "h-8 shrink-0 px-3 text-xs transition-colors duration-150",
        active
          ? "bg-accent-soft text-accent"
          : "bg-translucent text-soft hover:bg-surface-hover hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

function ProgramCatalog() {
  const { t } = useVoice();
  const [level, setLevel] = useState<ProgramLevel | "all">("all");
  const [goal, setGoal] = useState<ProgramGoal | "all">("all");
  const [equip, setEquip] = useState<EquipmentProfile | "all">("all");

  const filtered = useMemo(
    () =>
      PROGRAM_CATALOG.filter(
        (p) =>
          (level === "all" || p.level === level) &&
          (goal === "all" || p.goal === goal) &&
          (equip === "all" || equipmentProfile(p.equipment) === equip),
      ),
    [level, goal, equip],
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-24 md:pb-6">
      <div className="flex items-center gap-3">
        <Link
          to="/train"
          aria-label="Back to training"
          className="flex size-8 shrink-0 items-center justify-center text-faint transition-colors duration-150 hover:text-ink"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Programs</h1>
          <p className="text-2xs text-faint">
            Curated multi-week plans — save one as a folder of routines.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          <Chip
            label="All levels"
            active={level === "all"}
            onClick={() => setLevel("all")}
          />
          {(["beginner", "intermediate", "advanced"] as ProgramLevel[]).map(
            (l) => (
              <Chip
                key={l}
                label={LEVEL_LABELS[l]}
                active={level === l}
                onClick={() => setLevel(l)}
                testId={`filter-level-${l}`}
              />
            ),
          )}
        </div>
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          <Chip
            label="Any goal"
            active={goal === "all"}
            onClick={() => setGoal("all")}
          />
          {(["muscle", "strength", "general"] as ProgramGoal[]).map((g) => (
            <Chip
              key={g}
              label={GOAL_LABELS[g]}
              active={goal === g}
              onClick={() => setGoal(g)}
              testId={`filter-goal-${g}`}
            />
          ))}
        </div>
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          <Chip
            label="Any equipment"
            active={equip === "all"}
            onClick={() => setEquip("all")}
          />
          {(["gym", "dumbbell", "bodyweight"] as EquipmentProfile[]).map(
            (e) => (
              <Chip
                key={e}
                label={EQUIPMENT_PROFILE_LABELS[e]}
                active={equip === e}
                onClick={() => setEquip(e)}
                testId={`filter-equip-${e}`}
              />
            ),
          )}
        </div>
      </div>

      {/* Cards */}
      <div className="mt-4 flex flex-col gap-2">
        {filtered.map((p) => (
          <ProgramCard key={p.key} entry={p} />
        ))}
        {filtered.length === 0 && (
          <p className="py-8 text-center text-xs text-faint">
            {t(
              "No programs match those filters.",
              "No programs match those filters. The frog refuses to speculate.",
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function ProgramCard({ entry }: { entry: ProgramCatalogEntry }) {
  return (
    <Link
      to={`/programs/${entry.key}`}
      className="block border border-border bg-surface p-4 transition-colors duration-150 hover:bg-surface-hover"
      data-testid={`program-card-${entry.key}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{entry.name}</span>
        <span className="num shrink-0 text-2xs text-faint">
          {entry.daysPerWeek}×/week
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-faint">
        <span>{LEVEL_LABELS[entry.level]}</span>
        <span>·</span>
        <span>{GOAL_LABELS[entry.goal]}</span>
        <span>·</span>
        <span>
          {EQUIPMENT_PROFILE_LABELS[equipmentProfile(entry.equipment)]}
        </span>
        <span>·</span>
        <span className="num">{entry.minutesPerWorkout} min</span>
      </div>
      <p className="mt-2 text-xs text-soft">{entry.description}</p>
    </Link>
  );
}

function ProgramDetail({ programKey }: { programKey: string }) {
  const { t } = useVoice();
  const navigate = useNavigate();
  const entry = catalogEntry(programKey);
  const { data: exercises = [] } = useExercises();
  const { data: prefs = [] } = useExercisePrefs();
  const materialize = useMaterializeProgram();

  const generated = useMemo<GeneratedProgram | null>(() => {
    if (!entry || exercises.length === 0) return null;
    const excludedIds = new Set(
      prefs.filter((p) => p.generatorExcluded).map((p) => p.exerciseId),
    );
    return generateProgram(entryConfig(entry), selectableFrom(exercises), {
      excludedIds,
    });
  }, [entry, exercises, prefs]);

  const nameById = useMemo(
    () => new Map(exercises.map((e) => [e.id, e.name])),
    [exercises],
  );

  if (!entry) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 text-center">
        <p className="text-sm text-soft">
          {t(
            "Program not found.",
            "Program not found. The frog looked everywhere.",
          )}
        </p>
        <Link to="/programs" className="mt-2 inline-block text-xs text-accent">
          Back to programs
        </Link>
      </div>
    );
  }

  async function save() {
    if (!entry || !generated || materialize.isPending) return;
    await materialize.mutateAsync({
      program: generated,
      source: "library",
      config: null,
      libraryKey: entry.key,
      name: entry.name,
    });
    navigate("/routines");
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-24 md:pb-6">
      <div className="flex items-start gap-3">
        <Link
          to="/programs"
          aria-label="Back to programs"
          className="flex size-8 shrink-0 items-center justify-center text-faint transition-colors duration-150 hover:text-ink"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight">{entry.name}</h1>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-faint">
            <span>{LEVEL_LABELS[entry.level]}</span>
            <span>·</span>
            <span>{GOAL_LABELS[entry.goal]} focus</span>
            <span>·</span>
            <span>
              {EQUIPMENT_PROFILE_LABELS[equipmentProfile(entry.equipment)]}
            </span>
            <span>·</span>
            <span className="num">{entry.daysPerWeek}×/week</span>
            <span>·</span>
            <span className="num">{entry.minutesPerWorkout} min</span>
          </p>
        </div>
      </div>

      <p className="mt-4 text-sm text-soft">{entry.description}</p>

      <Button
        variant="primary"
        className="mt-4 w-full"
        disabled={!generated || materialize.isPending}
        onClick={() => void save()}
        data-testid="save-program-btn"
      >
        {materialize.isPending
          ? t("Saving…", "The frog is filing…")
          : "Save program"}
      </Button>

      {/* Per-routine preview */}
      <div className="mt-6 flex flex-col gap-3">
        {generated?.routines.map((r) => (
          <div key={r.name} className="border border-border bg-surface p-4">
            <div className="flex items-center gap-2">
              <Dumbbell className="size-4 text-faint" />
              <span className="text-sm font-medium">{r.name}</span>
              <span className="num text-2xs text-faint">
                {r.exercises.length} exercises
              </span>
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {r.exercises.map((ex) => {
                const first = ex.sets[0];
                const reps =
                  first?.targetRepsMax != null
                    ? `${first.targetReps}–${first.targetRepsMax}`
                    : `${first?.targetReps ?? ""}`;
                return (
                  <div
                    key={ex.exerciseId}
                    className="flex items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="truncate text-ink">
                      {nameById.get(ex.exerciseId) ?? "Exercise"}
                    </span>
                    <span className="num shrink-0 text-faint">
                      {ex.sets.length} × {reps}
                      {ex.restSec ? ` · ${ex.restSec}s rest` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {generated == null && (
          <p className="py-8 text-center text-xs text-faint">
            {t(
              "Loading your exercise library…",
              "The frog is thinking. Your exercise library is on its way.",
            )}
          </p>
        )}
      </div>
    </div>
  );
}
