import { Compass, Dumbbell, Play, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import { useActiveSession } from "@/lib/queries";
import { useStartSession } from "@/lib/start-session";
import { useVoice } from "@/lib/voice";

// Training — the session hub: start or resume a workout. Routine management
// (folders, list, create/edit) lives on its own Routines tab (/routines) since
// 2026-08-08 (docs/DECISIONS.md); this screen only starts and resumes sessions.

export default function TrainScreen() {
  const navigate = useNavigate();
  const { t } = useVoice();
  const { data: active } = useActiveSession();
  const { start, starting, error } = useStartSession();

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-20 md:pb-6">
      <h1 className="text-lg font-semibold tracking-tight">Training</h1>

      {/* Quick start */}
      <div className="mt-4 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {active && (
            <Button
              variant="primary"
              className="w-full sm:w-auto"
              onClick={() => navigate(`/session/${active.id}`)}
              data-testid="resume-session-btn"
            >
              <Play className="size-4" /> Resume session
            </Button>
          )}
          <Button
            variant={active ? "outline" : "primary"}
            className="w-full sm:w-auto"
            disabled={starting}
            onClick={() => void start()}
            data-testid="start-session-btn"
          >
            {!active && <Play className="size-4" />}
            {starting
              ? "Starting…"
              : active
                ? "Start empty workout"
                : "Start empty workout"}
          </Button>
          {active && (
            <span className="num self-center text-2xs text-faint">
              started {formatTime(active.startedAt)}
            </span>
          )}
        </div>
        {/* Error framing is playground; the exact message stays outside t()
            so the fact survives every register. */}
        {error && (
          <p className="mt-2 text-xs text-neg">
            {t(
              "Could not start the session.",
              "The frog is annoyed. The session did not start.",
            )}{" "}
            {error}
          </p>
        )}
      </div>

      {/* Programs + Trainer + Exercises entry points */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => navigate("/programs")}
          data-testid="programs-link"
        >
          <Compass className="size-4" /> Programs
        </Button>
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => navigate("/trainer")}
          data-testid="trainer-link"
        >
          <Sparkles className="size-4" /> Trainer
        </Button>
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => navigate("/library")}
          data-testid="exercises-link"
        >
          <Dumbbell className="size-4" /> Exercises
        </Button>
      </div>
    </div>
  );
}
