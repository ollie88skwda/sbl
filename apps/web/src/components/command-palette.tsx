import { Command } from "cmdk";
import {
  BookOpen,
  CalendarDays,
  Dumbbell,
  FlaskConical,
  History,
  Home,
  Lightbulb,
  LogOut,
  Moon,
  NotebookPen,
  type Play,
  Ruler,
  ScrollText,
  Settings,
  Sun,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useSignOut } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { themePortalContainer } from "@/lib/theme-portal";

type Item = {
  label: string;
  icon: typeof Play;
  action: () => void;
  keywords?: string;
  shortcut?: string;
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const signOut = useSignOut();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  const nav: Item[] = [
    { label: "Home", icon: Home, action: () => navigate("/") },
    { label: "Training", icon: Dumbbell, action: () => navigate("/train") },
    {
      label: "Routines",
      icon: NotebookPen,
      action: () => navigate("/routines"),
      keywords: "plans folders workout",
    },
    { label: "Profile", icon: User, action: () => navigate("/profile") },
    {
      label: "Library",
      icon: BookOpen,
      action: () => navigate("/library"),
      shortcut: "L",
    },
    {
      label: "History",
      icon: History,
      action: () => navigate("/history"),
      shortcut: "H",
    },
    {
      label: "Findings",
      icon: FlaskConical,
      action: () => navigate("/findings"),
      shortcut: "F",
    },
    {
      label: "Calendar",
      icon: CalendarDays,
      action: () => navigate("/calendar"),
      keywords: "streak consistency month year",
    },
    {
      label: "Measures",
      icon: Ruler,
      action: () => navigate("/measures"),
      keywords: "body weight measurements photos",
    },
    { label: "Settings", icon: Settings, action: () => navigate("/settings") },
    {
      label: "Training tips",
      icon: Lightbulb,
      action: () => navigate("/tips"),
      keywords: "lessons education info help",
    },
    {
      label: "Changelog",
      icon: ScrollText,
      action: () => navigate("/changelog"),
      keywords: "whats new updates decisions dev log",
    },
  ];

  const actions: Item[] = [
    {
      label:
        theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: theme === "dark" ? Sun : Moon,
      action: toggle,
      keywords: "theme toggle appearance",
    },
    {
      label: "Sign out",
      icon: LogOut,
      action: () => void signOut(),
      keywords: "logout",
    },
  ];

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      // Portal into the theme root so Radix's scoped radius token resolves
      // (rounded-xl → --radius-5) — otherwise the palette renders square. Same
      // fix as ui/dialog; see theme-portal.ts.
      container={themePortalContainer()}
      overlayClassName="fixed inset-0 z-50 bg-(--overlay)"
      contentClassName="float-in fixed top-[18%] left-1/2 z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-(--color-panel-solid) shadow-(--shadow-6)"
    >
      <Command.Input
        placeholder="Type a command…"
        className="h-11 w-full border-b border-border bg-transparent px-4 text-sm text-ink placeholder:text-faint focus:outline-none"
      />
      <Command.List className="max-h-72 overflow-y-auto p-1">
        <Command.Empty className="px-2 py-6 text-center text-xs text-faint">
          No results.
        </Command.Empty>
        <Command.Group
          heading="Go to"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase"
        >
          {nav.map((item) => (
            <PaletteItem key={item.label} item={item} onRun={run} />
          ))}
        </Command.Group>
        <Command.Group
          heading="Actions"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase"
        >
          {actions.map((item) => (
            <PaletteItem key={item.label} item={item} onRun={run} />
          ))}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}

function PaletteItem({
  item,
  onRun,
}: {
  item: Item;
  onRun: (a: () => void) => void;
}) {
  const Icon = item.icon;
  return (
    <Command.Item
      keywords={item.keywords ? [item.keywords] : undefined}
      onSelect={() => onRun(item.action)}
      className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-ink data-[selected=true]:bg-surface-hover"
    >
      <Icon className="size-4 shrink-0 text-soft" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.shortcut && <kbd className="keycap">{item.shortcut}</kbd>}
    </Command.Item>
  );
}
