import { FIRST_WEEKDAY, sevenDayMuscleSets } from "@frog/core";
import { BarChart3, Dumbbell, Plus, Users } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { HumanBodyHeatmap } from "@/components/charts/human-body-heatmap";
import { HomeHero } from "@/components/home-hero";
import { ReportPromo } from "@/components/report-promo";
import { StreakCard } from "@/components/streak-card";
import { TrainFindingsCard } from "@/components/train-findings-card";
import { useAllSessions } from "@/lib/profile-queries";
import { useRecordsData } from "@/lib/records-queries";
import { useMuscleMap } from "@/lib/stats-queries";
import { useVoice } from "@/lib/voice";

export default function HomeScreen() {
  const { t } = useVoice();
  const { data: sessions = [] } = useAllSessions();
  const { data: recordsData } = useRecordsData();
  const muscleMap = useMuscleMap();
  const starts = sessions.map((s) => s.startedAt);

  // Trailing-7-day muscle map for the mini heat map — deep-links into /stats.
  const sevenDay = useMemo(
    () =>
      recordsData
        ? sevenDayMuscleSets(recordsData.history, muscleMap, {
            now: Date.now(),
            includeWarmups: recordsData.includeWarmups,
            firstWeekday: FIRST_WEEKDAY,
          })
        : {},
    [recordsData, muscleMap],
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-20 md:pb-6">
      <h1 className="text-lg font-semibold tracking-tight">Home</h1>

      {/* Today's plan — the hero. Starting training is the screen's headline
          act, not a chip in a status row (docs/DECISIONS.md 2026-07-30). */}
      <HomeHero />

      {/* Monthly-report / Year-in-Review nudge (dismissible; time-gated). */}
      <ReportPromo />

      <Link to="/calendar" className="mt-4 block" data-testid="home-streak">
        <StreakCard starts={starts} />
      </Link>

      {/* Trailing-7-day muscle map — a glanceable teaser into full Statistics.
          The human figure (react-body-highlighter, same as /stats) in its
          non-interactive teaser mode: no chips, no selection, just the map
          (docs/DECISIONS.md 2026-08-08, Routines-tab & Home-heatmap entry). */}
      <Link
        to="/stats"
        className="mt-4 block rounded-lg border border-border bg-surface p-4 transition-colors duration-150 ease-(--ease-out-quad) hover:border-border-strong"
        data-testid="home-heatmap"
      >
        <div className="flex items-center gap-2 text-2xs font-medium tracking-widest text-faint uppercase">
          <BarChart3 className="size-4" />
          This week
        </div>
        <div className="mx-auto mt-2 max-w-56">
          <HumanBodyHeatmap muscleSets={sevenDay} interactive={false} />
        </div>
      </Link>

      {/* Exercises lives on Home — promoted above Findings and retitled so the
          "+ Custom" affordance (a straight deep-link into the create sheet,
          docs/DECISIONS.md) is reachable without a second navigation. */}
      <div className="mt-4 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-2">
          <Link
            to="/library"
            className="min-w-0 flex-1"
            data-testid="home-exercises"
          >
            <div className="flex items-center gap-2 text-2xs font-medium tracking-widest text-faint uppercase">
              <Dumbbell className="size-4" />
              Exercises
            </div>
            <p className="mt-2 text-sm text-soft">
              {t(
                "Browse exercises, machines, and tier ratings.",
                "Exercises, machines, and tier ratings. The frog has catalogued everything.",
              )}
            </p>
          </Link>
          <Link
            to="/library?new=1"
            className="flex shrink-0 items-center gap-1 bg-accent-soft px-2 py-1 text-2xs text-accent transition-colors duration-150 ease-(--ease-out-quad) hover:bg-accent/20"
            data-testid="home-exercises-new"
          >
            <Plus className="size-3.5" />
            Custom
          </Link>
        </div>
      </div>

      <TrainFindingsCard />

      {/* Social + graphs are a future phase — labeled, not faked. */}
      <div className="mt-4 rounded-lg border border-dashed border-border bg-surface p-4">
        <div className="flex items-center gap-2 text-2xs font-medium tracking-widest text-faint uppercase">
          <Users className="size-4" />
          Feed &amp; graphs
        </div>
        <p className="mt-2 text-sm text-faint">
          {t(
            "Coming soon — a training feed and progress charts.",
            "A training feed and progress charts, eventually. The frog refuses to speculate on dates.",
          )}
        </p>
      </div>
    </div>
  );
}
