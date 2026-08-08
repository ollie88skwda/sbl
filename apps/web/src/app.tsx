import { Theme } from "@radix-ui/themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "@/components/app-shell";
import { AuthProvider, RequireAuth } from "@/lib/auth";
import { RepoProvider } from "@/lib/repo";

// Home is lazy like every route: the shell paints instantly and the findings
// teaser it pulls in (findings engine) stays out of the eager chunk.
const HomeScreen = lazy(() => import("@/screens/home"));
const AuthScreen = lazy(() => import("@/screens/auth"));
const TrainScreen = lazy(() => import("@/screens/train"));
const RoutinesScreen = lazy(() => import("@/screens/routines"));
const RoutineEditScreen = lazy(() => import("@/screens/routine-edit"));
const ProgramsScreen = lazy(() => import("@/screens/programs"));
const TrainerScreen = lazy(() => import("@/screens/trainer"));
const ProfileScreen = lazy(() => import("@/screens/profile"));
const CalendarScreen = lazy(() => import("@/screens/calendar"));
const SessionScreen = lazy(() => import("@/screens/session"));
const LibraryScreen = lazy(() => import("@/screens/library"));
const ExerciseDetailScreen = lazy(() => import("@/screens/exercise-detail"));
const HistoryScreen = lazy(() => import("@/screens/history"));
const HistoryDetailScreen = lazy(() => import("@/screens/history-detail"));
const FindingsScreen = lazy(() => import("@/screens/findings"));
const MeasuresScreen = lazy(() => import("@/screens/measures"));
const StatsScreen = lazy(() => import("@/screens/stats"));
const MonthlyReportScreen = lazy(() => import("@/screens/monthly-report"));
const YearReviewScreen = lazy(() => import("@/screens/year-review"));
const SettingsScreen = lazy(() => import("@/screens/settings"));
const TipsScreen = lazy(() => import("@/screens/tips"));
const ChangelogScreen = lazy(() => import("@/screens/changelog"));
const NotFoundScreen = lazy(() => import("@/screens/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 15_000 },
    mutations: { retry: 3 },
  },
});

// Live theme editor (accent / gray / radius / scaling). Dev-only AND opt-in:
// the DEV ternary is statically false in prod so the dynamic import is
// dead-code-eliminated, and the flag keeps it from covering the top-right of
// the app (it's a fixed panel that intercepts pointer events) until you ask
// for it. Toggle with `localStorage.themePanel = "1"` (or add ?themePanel to
// the URL) and reload.
const showThemePanel =
  import.meta.env.DEV &&
  (localStorage.getItem("themePanel") === "1" ||
    new URLSearchParams(location.search).has("themePanel"));
const ThemePanel = showThemePanel
  ? lazy(() =>
      import("@radix-ui/themes").then((m) => ({ default: m.ThemePanel })),
    )
  : null;

// Click-to-comment overlay (src/dev/annotate/) — dev-only, off by default,
// toggled with the bare A key or its floating button. Same dead-branch shape as
// ThemePanel above: both conditions fold to a literal `false` in a production
// build, so Rollup drops the dynamic import and the whole subtree with it.
// VITE_E2E builds keep it so Playwright can drive the real thing; that build
// is already non-production (it also carries the __frog auth bridge).
// scripts/check-bundle.ts fails the build if it ever reaches production.
const AnnotateOverlay =
  import.meta.env.DEV || import.meta.env.VITE_E2E === "1"
    ? lazy(() => import("@/dev/annotate"))
    : null;

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Single source of look-and-feel — Frog re-skin, docs/DECISIONS.md
          2026-07-16 (grass accent · sage gray · 0px radius, per
          docs/brand/frog-brand-identity.html §14).
          `appearance` is deliberately unset: Radix reads the light/dark class
          that index.html sets pre-paint, which avoids a flash of wrong theme. */}
      <Theme
        accentColor="grass"
        grayColor="sage"
        radius="none"
        scaling="100%"
        panelBackground="solid"
      >
        <AuthProvider>
          <RepoProvider>
            <BrowserRouter>
              <Suspense fallback={null}>
                <Routes>
                  <Route path="/auth" element={<AuthScreen />} />
                  <Route element={<RequireAuth />}>
                    <Route element={<AppShell />}>
                      <Route index element={<HomeScreen />} />
                      <Route path="train" element={<TrainScreen />} />
                      <Route path="routines" element={<RoutinesScreen />} />
                      <Route
                        path="routines/new"
                        element={<RoutineEditScreen />}
                      />
                      <Route
                        path="routines/:id/edit"
                        element={<RoutineEditScreen />}
                      />
                      <Route path="programs" element={<ProgramsScreen />} />
                      <Route
                        path="programs/:key"
                        element={<ProgramsScreen />}
                      />
                      <Route path="trainer" element={<TrainerScreen />} />
                      <Route path="profile" element={<ProfileScreen />} />
                      <Route path="calendar" element={<CalendarScreen />} />
                      <Route path="session/:id" element={<SessionScreen />} />
                      <Route path="library" element={<LibraryScreen />} />
                      <Route
                        path="exercises/:id"
                        element={<ExerciseDetailScreen />}
                      />
                      <Route path="history" element={<HistoryScreen />} />
                      <Route
                        path="history/:id"
                        element={<HistoryDetailScreen />}
                      />
                      <Route path="findings" element={<FindingsScreen />} />
                      <Route path="measures" element={<MeasuresScreen />} />
                      <Route path="stats" element={<StatsScreen />} />
                      <Route
                        path="stats/monthly"
                        element={<MonthlyReportScreen />}
                      />
                      <Route path="stats/year" element={<YearReviewScreen />} />
                      <Route path="settings" element={<SettingsScreen />} />
                      <Route path="tips" element={<TipsScreen />} />
                      <Route path="changelog" element={<ChangelogScreen />} />
                      <Route path="*" element={<NotFoundScreen />} />
                    </Route>
                  </Route>
                </Routes>
              </Suspense>
            </BrowserRouter>
          </RepoProvider>
        </AuthProvider>
        {ThemePanel && (
          <Suspense fallback={null}>
            <ThemePanel />
          </Suspense>
        )}
        {AnnotateOverlay && (
          <Suspense fallback={null}>
            <AnnotateOverlay />
          </Suspense>
        )}
      </Theme>
    </QueryClientProvider>
  );
}
