import {
  EQUIPMENT_KINDS,
  EQUIPMENT_LABELS,
  type EquipmentDisplayKind,
  type EquipmentKind,
  EXERCISE_TYPE_LABELS,
  EXERCISE_TYPES,
  type Exercise,
  type ExerciseType,
  isConfidentMatch,
  JOINT_ACTIONS,
  jointActionLabel,
  LATERALITY,
  LATERALITY_LABELS,
  type Laterality,
  MECHANIC_LABELS,
  MECHANICS,
  type Mechanic,
  MOVEMENT_PATTERN_LABELS,
  MOVEMENT_PATTERNS,
  MUSCLES,
  type MuscleTarget,
  matchExerciseName,
  muscleLabel,
  type NewExerciseOpts,
  newId,
  primaryMuscles,
  ratingsForExercise,
  sameExerciseName,
  secondaryMuscles,
  type Tier,
} from "@frog/core";
import { Select } from "@radix-ui/themes";
import { Camera, ChevronDown, ChevronRight, Video, X } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { TierBadge } from "@/components/anatomy-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { resizePhoto } from "@/lib/photo";
import {
  useClearExerciseMedia,
  useCreateExercise,
  useExercise,
  useExerciseMediaUrl,
  useExercises,
  useLastSets,
  useMachines,
  useSeedExercises,
  useUpdateExercise,
  useUploadExerciseMedia,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

const TIERS: Tier[] = ["S", "A", "B", "C"];
const MEDIA_MAX_DIM = 1280; // matches machine/progress photo precedent
// Images are resized to a few hundred kB before they get here; a video is
// uploaded byte-for-byte, so it is the only thing that can hit this. Matches
// the exercise-media bucket's own file_size_limit — refuse it here, where the
// sheet is still open to say so, rather than letting storage reject it after.
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
// Some pickers hand back a File with an empty or unrecognised `type` (the
// Android "Files" provider, .mov/.heic outside Safari), so the MIME type alone
// can't decide this — a clip classed as an image goes to the image decoder and
// fails there instead. The extension has to name the container as well as the
// kind: storage serves back whatever content type it was handed, and a .mov
// stored as video/mp4 is a dead player in Firefox.
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  "3gp": "video/3gpp",
};
function classifyMedia(file: File): { kind: "image" | "video"; type: string } {
  if (file.type.startsWith("video/")) return { kind: "video", type: file.type };
  if (file.type.startsWith("image/")) return { kind: "image", type: file.type };
  const videoType = VIDEO_MIME[file.name.split(".").pop()?.toLowerCase() ?? ""];
  return videoType
    ? { kind: "video", type: videoType }
    : { kind: "image", type: file.type };
}

export type ExerciseEditorProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** Required when mode is "edit". */
  exercise?: Exercise;
  /** Create-mode name prefill (session picker search, routine-paste raw line). */
  initialName?: string;
  /**
   * Fires when Save is tapped in create mode, with the new row's id/name. On
   * a publish dupe-hit (the RPC backstop returned an existing row) it fires
   * again with the canonical row's id, since the optimistic id never became
   * a real row.
   */
  onCreated?: (id: string, name: string) => void;
};

// One sheet for both create and edit — designed at 390×844 and nowhere else
// (report §6.2). Section 1 is the fast path: name is the only required
// field, Save is enabled the moment it's non-empty.
export function ExerciseEditor({
  open,
  onOpenChange,
  mode,
  exercise,
  initialName,
  onCreated,
}: ExerciseEditorProps) {
  const navigate = useNavigate();
  const { data: exercises = [] } = useExercises();
  const { data: machines = [] } = useMachines();
  const { data: history = [] } = useLastSets(exercise?.id ?? "");
  const create = useCreateExercise();
  const seedExercises = useSeedExercises();
  const update = useUpdateExercise();
  const uploadMedia = useUploadExerciseMedia();
  const clearMedia = useClearExerciseMedia();
  // The `exercise` prop comes from the narrow library-list row (LIST_COLUMNS,
  // step 0), which carries every field this sheet writes but not
  // mediaPath/mediaType — fetch the full row so the demo clip renders (and
  // renders as the right element). placeholderData from the list row keeps
  // the sheet painting instantly either way.
  const { data: fullExercise } = useExercise(exercise?.id ?? "");
  const target = mode === "edit" ? (fullExercise ?? exercise) : undefined;
  const { data: mediaUrl } = useExerciseMediaUrl(target);

  const [name, setName] = useState("");
  const [duplicateOf, setDuplicateOf] = useState<Exercise | null>(null);
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasDraft, setAliasDraft] = useState("");
  const [primary, setPrimary] = useState<string[]>([]);
  const [secondary, setSecondary] = useState<string[]>([]);
  const [jointActions, setJointActionsState] = useState<string[]>([]);
  const [equipment, setEquipment] = useState("");
  const [machineId, setMachineId] = useState("");
  const [exerciseType, setExerciseType] = useState<ExerciseType>("weight_reps");
  const [mechanic, setMechanic] = useState<Mechanic | null>(null);
  const [movementPattern, setMovementPattern] = useState("");
  const [laterality, setLaterality] = useState<Laterality>("bilateral");
  const [repsMin, setRepsMin] = useState("");
  const [repsMax, setRepsMax] = useState("");
  const [restSec, setRestSec] = useState("");
  const [notes, setNotes] = useState("");
  const [tierDrafts, setTierDrafts] = useState<Record<string, Tier | null>>({});
  const [pendingMedia, setPendingMedia] = useState<{
    blob: Blob;
    kind: "image" | "video";
  } | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Radix unmounts DialogContent while closed, but re-opening the *same*
  // mounted editor for a different exercise (or from create back to create)
  // must not show the previous target's draft — reset explicitly on open.
  // The draft is seeded from whatever row is on hand (list placeholder or
  // full fetch): every field written back by `buildOpts` is in LIST_COLUMNS,
  // so the placeholder is complete for editing purposes and the sheet paints
  // filled in on the first frame. appliedRef makes this a one-shot sync, not
  // a live one, so the full row landing (or any later background refetch)
  // mid-edit can't stomp what the user is typing.
  const appliedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      appliedRef.current = false;
      return;
    }
    if (appliedRef.current) return;
    if (mode === "edit" && !target) return;
    appliedRef.current = true;
    setName(target?.name ?? initialName ?? "");
    setDuplicateOf(null);
    setAliases(target?.aliases ?? []);
    setAliasDraft("");
    setPrimary(target ? primaryMuscles(target.muscleTargets) : []);
    setSecondary(target ? secondaryMuscles(target.muscleTargets) : []);
    setJointActionsState(target?.jointActions ?? []);
    setEquipment(target?.equipment ?? "");
    setMachineId(target?.machineId ?? "");
    setExerciseType((target?.exerciseType as ExerciseType) ?? "weight_reps");
    setMechanic((target?.mechanic as Mechanic | null) ?? null);
    setMovementPattern(target?.movementPattern ?? "");
    // Legacy 'alternating' values read as bilateral (2026-08-08 — the option
    // is gone, folded into bilateral); a DB row still carrying it opens as
    // Bilateral and saving normalizes it.
    setLaterality(
      target?.laterality === "unilateral" ? "unilateral" : "bilateral",
    );
    setRepsMin(target?.defaultRepsMin?.toString() ?? "");
    setRepsMax(target?.defaultRepsMax?.toString() ?? "");
    setRestSec(target?.defaultRestSec?.toString() ?? "");
    setNotes(target?.notes ?? "");
    setTierDrafts(
      Object.fromEntries(
        (target?.muscleTargets ?? []).map((t) => [t.muscle, t.tier]),
      ),
    );
    setPendingMedia(null);
    setMediaError(null);
    setDefaultsOpen(false);
    setReferenceOpen(false);
    setAdvancedOpen(false);
  }, [open, mode, target, initialName]);

  const typeLocked = mode === "edit" && history.length > 0;
  const selectedMuscles = [...primary, ...secondary];
  // Auto-default (report §6.2): a default the user can correct, not an
  // inference they can't see — shown as selected until explicitly changed.
  const effectiveMechanic: Mechanic =
    mechanic ?? (selectedMuscles.length >= 2 ? "compound" : "isolation");

  // tierDrafts stays {} in create mode (the Advanced section never renders
  // there), so this reads null for every muscle exactly as before.
  const draftMuscleTargets: MuscleTarget[] = [
    ...primary.map((muscle) => ({
      muscle,
      tier: tierDrafts[muscle] ?? null,
      role: "primary" as const,
    })),
    ...secondary.map((muscle) => ({
      muscle,
      tier: tierDrafts[muscle] ?? null,
      role: "secondary" as const,
    })),
  ];
  const ratings = ratingsForExercise({
    jointActions,
    muscleTargets: draftMuscleTargets,
  }).filter((r) => r.tier != null);

  function checkDuplicate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setDuplicateOf(null);
      return;
    }
    // Community dedupe (dedupe-strictness decision, docs/DECISIONS.md
    // 2026-08-08): a confident fuzzy hit against the shared library warns
    // "use it instead" — a warn, never a block. Only global rows (owner_id
    // null) count: a match against the user's own private row is their own
    // business, and the server backstop dedupes against the same population.
    const shared = exercises.filter((e) => e.ownerId === null);
    const sharedMatch = matchExerciseName(trimmed, shared);
    if (sharedMatch && isConfidentMatch(sharedMatch)) {
      setDuplicateOf(sharedMatch);
      return;
    }
    // The existing exact-name warn against the user's own rows (a rename
    // collision in edit mode, a duplicate of their own custom exercise).
    const hit = exercises.find(
      (e) => e.id !== exercise?.id && sameExerciseName(e.name, trimmed),
    );
    setDuplicateOf(hit ?? null);
  }

  // Takes the raw text explicitly: the comma shortcut fires from inside the
  // input's own `onChange`, where `aliasDraft` is still the pre-change value —
  // a pasted "OHP," would otherwise commit nothing and clear the field. Commas
  // separate, so a multi-alias paste lands as several chips.
  function addAlias(raw: string = aliasDraft) {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setAliasDraft("");
    if (parts.length === 0) return;
    setAliases((prev) => {
      const next = [...prev];
      for (const p of parts) if (!next.includes(p)) next.push(p);
      return next;
    });
  }

  async function onMediaPicked(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const { kind, type } = classifyMedia(file);
    let blob: Blob = file;
    if (kind === "image") {
      try {
        blob = await resizePhoto(file, MEDIA_MAX_DIM);
      } catch {
        setMediaError(
          "Couldn't read that file — pick a photo or a video clip.",
        );
        return;
      }
    } else if (file.type !== type) {
      blob = file.slice(0, file.size, type);
    }
    if (blob.size > MEDIA_MAX_BYTES) {
      setMediaError(
        `That ${kind} is ${Math.round(blob.size / (1024 * 1024))} MB — the limit is 50 MB. Trim it and try again.`,
      );
      return;
    }
    setMediaError(null);
    if (mode === "edit" && exercise) {
      // The sheet stays open through an edit-mode upload, so a rejection
      // (storage's own size ceiling, a dropped connection) has somewhere to
      // land instead of leaving the user believing the clip attached.
      uploadMedia.mutate(
        { exerciseId: exercise.id, file: blob, kind },
        {
          onError: () => setMediaError("Couldn't upload that file. Try again."),
        },
      );
    } else {
      setPendingMedia({ blob, kind });
    }
  }

  // Select options for the Equipment field: the current kinds plus, when the
  // exercise already carries a removed gimmick kind (kettlebell/band/suspension
  // — pre-purge customs, docs/DECISIONS.md 2026-08-08), a disabled option with
  // its legacy label so the field renders the real value instead of a blank.
  // A disabled item can't be re-picked; saving untouched keeps the stored value.
  function equipmentOptions() {
    const opts: { value: string; label: string; disabled?: boolean }[] =
      EQUIPMENT_KINDS.map((k) => ({
        value: k,
        label: EQUIPMENT_LABELS[k],
      }));
    if (equipment && !EQUIPMENT_KINDS.includes(equipment as EquipmentKind)) {
      opts.push({
        value: equipment,
        label: EQUIPMENT_LABELS[equipment as EquipmentDisplayKind] ?? "Other",
        disabled: true,
      });
    }
    return opts;
  }

  function buildOpts() {
    return {
      muscleTargets: draftMuscleTargets.length ? draftMuscleTargets : null,
      jointActions: jointActions.length ? jointActions : null,
      machineId: machineId || null,
      exerciseType,
      equipment: equipment || null,
      mechanic: effectiveMechanic,
      movementPattern: movementPattern || null,
      laterality,
      defaultRepsMin: repsMin.trim() ? Number.parseInt(repsMin, 10) : null,
      defaultRepsMax: repsMax.trim() ? Number.parseInt(repsMax, 10) : null,
      defaultRestSec: restSec.trim() ? Number.parseInt(restSec, 10) : null,
      notes: notes.trim() || null,
      aliases: aliases.length ? aliases : null,
    };
  }

  // Optimistic, like every other write in this app (AGENTS.md): the sheet
  // closes the instant Save is tapped, it never waits on the network. The id
  // is generated here (not left to the server) so a staged media file can be
  // uploaded against it without a round trip to learn it — but the upload
  // itself waits for the INSERT to land (pending-exercises.ts): it stamps
  // media_path onto that row, and an UPDATE that overtakes the INSERT matches
  // nothing and reports no error, orphaning the object in the bucket.
  function onSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (mode === "create") {
      const id = newId();
      const staged = pendingMedia;
      const opts: NewExerciseOpts = { id, ...buildOpts() };
      // A create carrying a machine link or staged demo media stays private:
      // the publish RPC's parameter whitelist has no machine_id/media, so
      // publishing would silently drop them. The note under Save says so.
      if (machineId || staged) opts.share = false;
      // Synchronously, before dispatch: `onCreated` below hands this id to
      // consumers that write it as a foreign key the moment it stops being
      // pending, and `onMutate` doesn't run until a microtask later.
      seedExercises([{ name: trimmed, opts }]);
      create
        .mutateAsync({ name: trimmed, opts })
        .then((created) => {
          // Publish dupe-hit: the RPC's dedupe backstop returned an existing
          // row's id, so the optimistic id never became a real row — re-fire
          // onCreated with the canonical id so consumers waiting on it (the
          // session picker's auto-pick, the routine paste twin-resolve) land
          // on the row that actually exists.
          if (created.id !== id) onCreated?.(created.id, trimmed);
          if (staged) {
            uploadMedia.mutate({
              exerciseId: id,
              file: staged.blob,
              kind: staged.kind,
            });
          }
        })
        // Rollback + the failure notice belong to useCreateExercise; this only
        // keeps a failed create from surfacing as an unhandled rejection.
        .catch(() => {});
      onCreated?.(id, trimmed);
    } else if (exercise) {
      update.mutate({
        exerciseId: exercise.id,
        patch: { name: trimmed, ...buildOpts() },
      });
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={mode === "create" ? "Custom exercise" : "Edit exercise"}
      >
        <div className="flex flex-col gap-5">
          {/* Section 1 — Identity (fast path) */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-2xs font-medium tracking-widest text-faint uppercase">
                Name
              </span>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={checkDuplicate}
                placeholder="Zercher Squat"
                className="h-10"
                aria-label="Exercise name"
                data-testid="exercise-name-input"
              />
            </div>
            {duplicateOf && (
              <p
                className="text-2xs text-warn"
                data-testid="exercise-editor-duplicate"
              >
                {duplicateOf.ownerId === null
                  ? `Already in the shared library as "${duplicateOf.name}" — use it instead.`
                  : `Matches an existing exercise, "${duplicateOf.name}".`}{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/exercises/${duplicateOf.id}`);
                  }}
                >
                  Open the existing one
                </button>
              </p>
            )}
            <AliasChips
              aliases={aliases}
              draft={aliasDraft}
              onDraftChange={setAliasDraft}
              onAdd={addAlias}
              onRemove={(a) => setAliases(aliases.filter((x) => x !== a))}
            />
          </div>

          {/* Section 2 — What it trains (open by default) */}
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-2xs font-medium tracking-widest text-faint uppercase">
              What it trains
            </h3>
            {mode === "edit" &&
              (primary.length > 0 || secondary.length > 0) && (
                <p className="text-2xs text-faint">
                  Changing muscles updates your past statistics too.
                </p>
              )}
            <MusclePicker
              label="Primary muscles"
              selected={primary}
              exclude={secondary}
              onAdd={(m) => setPrimary([...primary, m])}
              onRemove={(m) => setPrimary(primary.filter((x) => x !== m))}
            />
            <MusclePicker
              label="Secondary muscles"
              selected={secondary}
              exclude={primary}
              onAdd={(m) => setSecondary([...secondary, m])}
              onRemove={(m) => setSecondary(secondary.filter((x) => x !== m))}
            />
            <JointActionPicker
              selected={jointActions}
              onAdd={(a) => setJointActionsState([...jointActions, a])}
              onRemove={(a) =>
                setJointActionsState(jointActions.filter((x) => x !== a))
              }
            />
            {ratings.length > 0 && (
              <ul className="flex flex-col gap-1">
                {ratings.map((r) => (
                  <li
                    key={r.jointAction}
                    className="flex items-center gap-1.5 text-2xs text-soft"
                  >
                    <TierBadge tier={r.tier} />
                    {jointActionLabel(r.jointAction)} trains{" "}
                    {r.muscle && muscleLabel(r.muscle)} at tier {r.tier}.
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Section 3 — How it's performed (one control per row) */}
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <h3 className="text-2xs font-medium tracking-widest text-faint uppercase">
              How it's performed
            </h3>
            <LabeledSelect
              label="Equipment"
              value={equipment}
              onChange={setEquipment}
              placeholder="No equipment"
              testId="exercise-editor-equipment"
              options={equipmentOptions()}
            />
            <LabeledSelect
              label="Machine"
              value={machineId}
              onChange={setMachineId}
              placeholder="No machine"
              testId="exercise-editor-machine"
              options={machines.map((m) => ({
                value: m.id,
                label: m.brand ? `${m.brand} · ${m.name}` : m.name,
              }))}
            />
            <LabeledSelect
              label="Measurement type"
              value={exerciseType}
              onChange={(v) => setExerciseType(v as ExerciseType)}
              disabled={typeLocked}
              hint={typeLocked ? "locked — has logged sets" : undefined}
              testId="exercise-type-select"
              options={EXERCISE_TYPES.map((t) => ({
                value: t,
                label: EXERCISE_TYPE_LABELS[t],
              }))}
            />
            <SegmentedField label="Mechanic">
              {MECHANICS.map((m) => (
                <SegmentedButton
                  key={m}
                  active={effectiveMechanic === m}
                  onClick={() => setMechanic(m)}
                  testId={`exercise-editor-mechanic-${m}`}
                >
                  {MECHANIC_LABELS[m]}
                </SegmentedButton>
              ))}
            </SegmentedField>
            <LabeledSelect
              label="Pattern"
              value={movementPattern}
              onChange={setMovementPattern}
              placeholder="Unset"
              testId="exercise-editor-pattern"
              options={MOVEMENT_PATTERNS.map((p) => ({
                value: p,
                label: MOVEMENT_PATTERN_LABELS[p],
              }))}
            />
            <SegmentedField label="Laterality">
              {LATERALITY.map((l) => (
                <SegmentedButton
                  key={l}
                  active={laterality === l}
                  onClick={() => setLaterality(l)}
                  testId={`exercise-editor-laterality-${l}`}
                >
                  {LATERALITY_LABELS[l]}
                </SegmentedButton>
              ))}
            </SegmentedField>
          </div>

          {/* Section 4 — Defaults (collapsed) */}
          <CollapsibleSection
            title="Defaults"
            open={defaultsOpen}
            onToggle={() => setDefaultsOpen((o) => !o)}
            testId="exercise-editor-defaults"
          >
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-2xs text-faint">
                Target reps
              </span>
              <Input
                inputMode="numeric"
                value={repsMin}
                onChange={(e) => setRepsMin(e.target.value.replace(/\D/g, ""))}
                placeholder="8"
                className="num h-10 w-16"
              />
              <span className="text-faint">–</span>
              <Input
                inputMode="numeric"
                value={repsMax}
                onChange={(e) => setRepsMax(e.target.value.replace(/\D/g, ""))}
                placeholder="12"
                className="num h-10 w-16"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-2xs text-faint">Rest</span>
              <Input
                inputMode="numeric"
                value={restSec}
                onChange={(e) => setRestSec(e.target.value.replace(/\D/g, ""))}
                placeholder="150"
                className="num h-10 w-20"
              />
              <span className="text-2xs text-faint">seconds</span>
            </div>
            <p className="text-2xs text-faint">
              Doesn't set the in-workout rest timer — feeds the Trainer's
              duration estimate only.
            </p>
          </CollapsibleSection>

          {/* Section 5 — Reference (collapsed) */}
          <CollapsibleSection
            title="Reference"
            open={referenceOpen}
            onToggle={() => setReferenceOpen((o) => !o)}
            testId="exercise-editor-reference"
          >
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes / cues — brace before you unrack; elbows high"
              rows={3}
              className="w-full border border-border bg-surface px-2 py-2 text-sm text-ink placeholder:text-faint"
              data-testid="exercise-editor-notes"
            />
            <MediaField
              mediaUrl={mediaUrl ?? null}
              mediaType={
                mode === "edit"
                  ? (target?.mediaType ?? null)
                  : (pendingMedia?.kind ?? null)
              }
              hasPending={!!pendingMedia}
              error={mediaError}
              onPick={onMediaPicked}
              onClear={
                mode === "edit" && exercise
                  ? () => clearMedia.mutate(exercise.id)
                  : () => setPendingMedia(null)
              }
            />
          </CollapsibleSection>

          {/* Advanced — tier overrides. Edit-only: 862/882 book rows are
              untiered, and defaulting a hand-added exercise to any tier
              would lie about how rated it is (see anatomy-ui's
              tierNameClass). Present here, off the create form. */}
          {mode === "edit" && selectedMuscles.length > 0 && (
            <CollapsibleSection
              title="Advanced: tier per muscle"
              open={advancedOpen}
              onToggle={() => setAdvancedOpen((o) => !o)}
              testId="exercise-editor-advanced"
            >
              {selectedMuscles.map((muscle) => (
                <div key={muscle} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-2xs text-soft">
                    {muscleLabel(muscle)}
                  </span>
                  <LabeledSelect
                    value={tierDrafts[muscle] ?? ""}
                    onChange={(v) =>
                      setTierDrafts({
                        ...tierDrafts,
                        [muscle]: (v || null) as Tier | null,
                      })
                    }
                    placeholder="Unset"
                    testId={`exercise-editor-tier-${muscle}`}
                    options={TIERS.map((t) => ({ value: t, label: t }))}
                    triggerClassName="w-24 shrink-0"
                  />
                </div>
              ))}
            </CollapsibleSection>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
          {mode === "create" && (machineId || pendingMedia) && (
            <p
              className="mr-auto self-center text-2xs text-warn"
              data-testid="exercise-editor-not-shared"
            >
              Not shared — includes a machine or demo photo.
            </p>
          )}
          <Button
            variant="outline"
            size="lg"
            onClick={() => onOpenChange(false)}
            data-testid="exercise-editor-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!name.trim()}
            onClick={onSave}
            data-testid="add-exercise-btn"
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CollapsibleSection({
  title,
  open,
  onToggle,
  testId,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border pt-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-10 w-full items-center gap-2 text-left"
        data-testid={testId}
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-faint" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-faint" />
        )}
        <span className="text-2xs font-medium tracking-widest text-faint uppercase">
          {title}
        </span>
      </button>
      {open && <div className="flex flex-col gap-3 pt-1">{children}</div>}
    </div>
  );
}

function SegmentedField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs text-faint">{label}</span>
      <div className="flex gap-1">{children}</div>
    </div>
  );
}

function SegmentedButton({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-10 flex-1 text-xs transition-colors duration-150",
        active
          ? "bg-accent-soft text-accent"
          : "bg-translucent text-soft hover:bg-surface-hover hover:text-ink",
      )}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

// Radix Select throughout (never a raw <select>, B8) — every popover here
// opens via Radix's own portal, which stays clear of this dialog's own
// overflow-y-auto scroll container.
function LabeledSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  hint,
  testId,
  triggerClassName = "w-full",
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
  testId: string;
  /** Override when this select sits beside another element in a row
   * (e.g. a muscle-name label) instead of owning the full row. */
  triggerClassName?: string;
}) {
  const body = (
    // A literal "" (never `undefined`) keeps this fully controlled — an
    // "add" picker (muscle/joint-action) resets to "" after every pick, and
    // an uncontrolled Select keeps its own last-picked value internally,
    // which then can't resolve once that option is excluded from the list.
    <Select.Root
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      size="2"
    >
      <Select.Trigger
        variant="surface"
        placeholder={placeholder}
        className={cn("h-10", triggerClassName)}
        data-testid={testId}
      />
      <Select.Content>
        {options.map((o) => (
          <Select.Item key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
  if (!label) return body;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs text-faint">{label}</span>
      {body}
      {hint && <span className="text-2xs text-faint">{hint}</span>}
    </div>
  );
}

function MusclePicker({
  label,
  selected,
  exclude,
  onAdd,
  onRemove,
}: {
  label: string;
  selected: string[];
  exclude: string[];
  onAdd: (muscle: string) => void;
  onRemove: (muscle: string) => void;
}) {
  const taken = new Set([...selected, ...exclude]);
  const available = MUSCLES.filter((m) => !taken.has(m.key));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs text-faint">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((muscle) => (
          <Chip key={muscle} onRemove={() => onRemove(muscle)}>
            {muscleLabel(muscle)}
          </Chip>
        ))}
        {available.length > 0 && (
          <LabeledSelect
            value=""
            onChange={onAdd}
            placeholder="+ muscle"
            testId={`exercise-editor-add-${label.toLowerCase().replace(/\s+/g, "-")}`}
            options={available.map((m) => ({ value: m.key, label: m.label }))}
          />
        )}
      </div>
    </div>
  );
}

function JointActionPicker({
  selected,
  onAdd,
  onRemove,
}: {
  selected: string[];
  onAdd: (action: string) => void;
  onRemove: (action: string) => void;
}) {
  const available = JOINT_ACTIONS.filter((a) => !selected.includes(a.key));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs text-faint">Joint actions</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((action) => (
          <Chip key={action} onRemove={() => onRemove(action)}>
            {jointActionLabel(action)}
          </Chip>
        ))}
        {available.length > 0 && (
          <LabeledSelect
            value=""
            onChange={onAdd}
            placeholder="+ action"
            testId="exercise-editor-add-joint-action"
            options={available.map((a) => ({ value: a.key, label: a.label }))}
          />
        )}
      </div>
    </div>
  );
}

function AliasChips({
  aliases,
  draft,
  onDraftChange,
  onAdd,
  onRemove,
}: {
  aliases: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onAdd: (raw?: string) => void;
  onRemove: (alias: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs text-faint">Also known as</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {aliases.map((a) => (
          <Chip key={a} onRemove={() => onRemove(a)}>
            {a}
          </Chip>
        ))}
        <Input
          value={draft}
          onChange={(e) => {
            if (e.target.value.includes(",")) {
              onAdd(e.target.value);
            } else {
              onDraftChange(e.target.value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          onBlur={() => onAdd()}
          placeholder="+ add alias"
          className="h-10 w-32"
          data-testid="exercise-editor-alias-input"
        />
      </div>
    </div>
  );
}

function Chip({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <span className="flex h-8 items-center gap-1.5 border border-border bg-surface px-2 text-xs text-soft">
      {children}
      <button
        type="button"
        title="Remove"
        onClick={onRemove}
        className="flex size-5 items-center justify-center text-faint hover:text-neg"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

function MediaField({
  mediaUrl,
  mediaType,
  hasPending,
  error,
  onPick,
  onClear,
}: {
  mediaUrl: string | null;
  mediaType: string | null;
  hasPending: boolean;
  error: string | null;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-2xs text-faint">Demo image or video</span>
      {error && (
        <p
          className="text-2xs text-neg"
          data-testid="exercise-editor-media-error"
        >
          {error}
        </p>
      )}
      {mediaUrl &&
        (mediaType === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: a silent self-recorded demo clip has no dialogue to caption.
          <video
            src={mediaUrl}
            controls
            className="max-h-56 w-full border border-border bg-black object-contain"
          />
        ) : (
          <img
            src={mediaUrl}
            alt="Exercise demo"
            className="max-h-56 w-full border border-border bg-white object-contain"
          />
        ))}
      <div className="flex items-center gap-2">
        <label className="flex h-10 flex-1 cursor-pointer items-center justify-center gap-2 bg-translucent px-2 text-xs text-soft shadow-(--inset-control) transition-colors duration-150 hover:bg-surface-hover hover:text-ink">
          <Camera className="size-4" />
          <Video className="size-4" />
          {mediaUrl || hasPending ? "Replace" : "Add image or video"}
          <input
            type="file"
            accept="image/*,video/*"
            onChange={onPick}
            className="hidden"
            data-testid="exercise-editor-media-input"
          />
        </label>
        {(mediaUrl || hasPending) && (
          <Button
            variant="ghost"
            size="lg"
            onClick={onClear}
            data-testid="exercise-editor-media-clear"
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
