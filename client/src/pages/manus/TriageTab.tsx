import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  Mail,
  MessageSquare,
  Briefcase,
  Bell,
  ListTodo,
  Timer,
  CheckCircle,
  Plus,
  Trash2,
  ArrowRight,
  Copy,
  ClipboardList,
  FileText,
  Moon,
  Star,
  CalendarClock,
  ExternalLink,
  Play,
  Pause,
  RotateCcw,
  AlertTriangle,
  Zap,
  Edit2,
  Save,
  MessageSquareWarning,
  Sun,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────
interface Task {
  id: string;
  text: string;
  platform: string;
  timeSpent: number; // seconds
  isRunning: boolean;
  completed: boolean;
  documented: boolean;
  priority: boolean;
  estimatedTime: number; // minutes
  startedAt?: number;
}

type View = "intro" | "triage" | "summary" | "focus_mode" | "evening_review" | "evening_summary";

// ─── Triage Steps ─────────────────────────────────────────────────────────────
const TRIAGE_STEPS = [
  {
    id: "email",
    label: "Email Inbox",
    type: "triage" as const,
    icon: <Mail className="w-5 h-5 text-blue-600" />,
    color: "bg-blue-50 dark:bg-blue-950/30",
    borderColor: "border-blue-400",
    instruction: "Open Gmail. Go top to bottom. For each email: reply, file, or create a Trello card.",
    link: "https://mail.google.com",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    type: "triage" as const,
    icon: <MessageSquare className="w-5 h-5 text-emerald-600" />,
    color: "bg-emerald-50 dark:bg-emerald-950/30",
    borderColor: "border-emerald-400",
    instruction: "Open WhatsApp. Go top to bottom. Reply to all unread messages. Convert tasks to Trello.",
    link: "https://web.whatsapp.com",
  },
  {
    id: "upwork",
    label: "Upwork Messages",
    type: "triage" as const,
    icon: <Briefcase className="w-5 h-5 text-green-600" />,
    color: "bg-green-50 dark:bg-green-950/30",
    borderColor: "border-green-400",
    instruction: "Open Upwork. Go top to bottom. Reply to all messages. Archive inactive conversations.",
    link: "https://www.upwork.com/messages",
  },
  {
    id: "trello_notifs",
    label: "Trello Notifications",
    type: "triage" as const,
    icon: <Bell className="w-5 h-5 text-orange-600" />,
    color: "bg-orange-50 dark:bg-orange-950/30",
    borderColor: "border-orange-400",
    instruction: "Open Trello notifications. Review all unread. Update cards that need action.",
    link: "https://trello.com/",
  },
  {
    id: "planning",
    label: "Major Tasks (APTLSS)",
    type: "planning" as const,
    icon: <ListTodo className="w-5 h-5 text-purple-600" />,
    color: "bg-purple-50 dark:bg-purple-950/30",
    borderColor: "border-purple-400",
    instruction: "Open your assigned Trello cards. Log each 'Doing' task below with an estimated time.",
    link: "https://trello.com/",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatTriageTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function TriageTab() {
  const today = getTodayDate();
  const [view, setView] = useState<View>("intro");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [deferredTasks, setDeferredTasks] = useState<Task[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const [workerProfile, setWorkerProfile] = useState<any>(null);

  useEffect(() => {
    fetch('/api/va/worker/profile', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) setWorkerProfile(data);
      })
      .catch(err => console.error("Error fetching worker profile in TriageTab:", err));
  }, []);

  const triageSteps = useMemo(() => {
    const trelloLink = workerProfile?.trelloMemberId 
      ? `https://trello.com/${workerProfile.trelloMemberId}/cards` 
      : "https://trello.com/your/cards";
    return [
      {
        id: "email",
        label: "Email Inbox",
        type: "triage" as const,
        icon: <Mail className="w-5 h-5 text-blue-600" />,
        color: "bg-blue-50 dark:bg-blue-950/30",
        borderColor: "border-blue-400",
        instruction: "Open Gmail. Go top to bottom. For each email: reply, file, or create a Trello card.",
        link: "https://mail.google.com",
      },
      {
        id: "whatsapp",
        label: "WhatsApp",
        type: "triage" as const,
        icon: <MessageSquare className="w-5 h-5 text-emerald-600" />,
        color: "bg-emerald-50 dark:bg-emerald-950/30",
        borderColor: "border-emerald-400",
        instruction: "Open WhatsApp. Go top to bottom. Reply to all unread messages. Convert tasks to Trello.",
        link: "https://web.whatsapp.com",
      },
      {
        id: "upwork",
        label: "Upwork Messages",
        type: "triage" as const,
        icon: <Briefcase className="w-5 h-5 text-green-600" />,
        color: "bg-green-50 dark:bg-green-950/30",
        borderColor: "border-green-400",
        instruction: "Open Upwork. Go top to bottom. Reply to all messages. Archive inactive conversations.",
        link: "https://www.upwork.com/messages",
      },
      {
        id: "trello_notifs",
        label: "Trello Notifications",
        type: "triage" as const,
        icon: <Bell className="w-5 h-5 text-orange-600" />,
        color: "bg-orange-50 dark:bg-orange-950/30",
        borderColor: "border-orange-400",
        instruction: "Open Trello notifications. Review all unread. Update cards that need action.",
        link: "https://trello.com/",
      },
      {
        id: "planning",
        label: "Major Tasks (APTLSS)",
        type: "planning" as const,
        icon: <ListTodo className="w-5 h-5 text-purple-600" />,
        color: "bg-purple-50 dark:bg-purple-950/30",
        borderColor: "border-purple-400",
        instruction: "Open your assigned Trello cards. Log each 'Doing' task below with an estimated time.",
        link: trelloLink,
      },
    ];
  }, [workerProfile]);

  // Track which morning ritual steps are done
  const [stepsDone, setStepsDone] = useState<boolean[]>([false, false, false, false, false]);
  const [eveningStepsDone, setEveningStepsDone] = useState<boolean[]>([false, false, false, false]);
  const [dbLoaded, setDbLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DB queries
  const { data: savedState } = trpc.triage.getByDate.useQuery({ date: today });
  const { data: recentReports } = trpc.triage.getRecent.useQuery({ limit: 7 });
  const upsertTriage = trpc.triage.upsert.useMutation();

  const [newTask, setNewTask] = useState("");
  const [newDuration, setNewDuration] = useState("");
  const [isHighPriority, setIsHighPriority] = useState(false);

  // Auto-save helper (debounced 1s)
  const scheduleSave = useCallback((patch: Omit<Parameters<typeof upsertTriage.mutate>[0], 'triageDate'>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      upsertTriage.mutate({ triageDate: today, ...patch });
    }, 1000);
  }, [today, upsertTriage]);

  // Triage 2-min timer
  const [isTriageTimerActive, setIsTriageTimerActive] = useState(false);
  const [triageTimeLeft, setTriageTimeLeft] = useState(120);
  const triageTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Focus mode
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [idleTime, setIdleTime] = useState(0);
  const [isIdleRunning, setIsIdleRunning] = useState(false);
  const focusTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // EOD / summary
  const [dailyFeedback, setDailyFeedback] = useState("");
  const [eodNotes, setEodNotes] = useState("");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [snippetFeedbackId, setSnippetFeedbackId] = useState<string | null>(null);

  // Time editing
  const [editingTimeId, setEditingTimeId] = useState<string | null>(null);
  const [tempTimeEdit, setTempTimeEdit] = useState("");

  // Load saved state when it arrives (all state declared above)
  if (savedState && !dbLoaded) {
    setDbLoaded(true);
    const s = savedState;
    setStepsDone([s.step1Done, s.step2Done, s.step3Done, s.step4Done, s.step5Done]);
    setEveningStepsDone([s.eveningStep1Done, s.eveningStep2Done, s.eveningStep3Done, s.eveningStep4Done]);
    if (s.eodReport) setEodNotes(s.eodReport);
    // Always start at intro when navigating to Triage — do not resume mid-flow
    if (s.focusTasks) {
      try {
        const parsed = JSON.parse(s.focusTasks);
        if (Array.isArray(parsed)) setTasks(parsed);
      } catch {}
    }
  }

  const currentStep = triageSteps[currentStepIndex];

  // ── Triage timer ────────────────────────────────────────────────────────────
  const startTriageTimer = useCallback(() => {
    setTriageTimeLeft(120);
    setIsTriageTimerActive(true);
  }, []);

  const stopTriageTimer = useCallback(() => {
    setIsTriageTimerActive(false);
    if (triageTimerRef.current) clearInterval(triageTimerRef.current);
  }, []);

  useEffect(() => {
    if (isTriageTimerActive) {
      triageTimerRef.current = setInterval(() => {
        setTriageTimeLeft((t) => {
          if (t <= 1) {
            setIsTriageTimerActive(false);
            return 0;
          }
          return t - 1;
        });
      }, 1000);
    }
    return () => { if (triageTimerRef.current) clearInterval(triageTimerRef.current); };
  }, [isTriageTimerActive]);

  // ── Focus mode timers ────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTaskId) {
      focusTimerRef.current = setInterval(() => {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === activeTaskId && t.isRunning
              ? { ...t, timeSpent: t.timeSpent + 1 }
              : t
          )
        );
      }, 1000);
      if (idleTimerRef.current) clearInterval(idleTimerRef.current);
      setIsIdleRunning(false);
    } else {
      if (focusTimerRef.current) clearInterval(focusTimerRef.current);
      if (view === "focus_mode") {
        setIsIdleRunning(true);
        idleTimerRef.current = setInterval(() => setIdleTime((t) => t + 1), 1000);
      }
    }
    return () => {
      if (focusTimerRef.current) clearInterval(focusTimerRef.current);
      if (idleTimerRef.current) clearInterval(idleTimerRef.current);
    };
  }, [activeTaskId, view]);

  // ── Task actions ─────────────────────────────────────────────────────────────
  const addTaskToToday = useCallback(() => {
    if (!newTask.trim()) return;
    const task: Task = {
      id: generateId(),
      text: newTask.trim(),
      platform: currentStep.label,
      timeSpent: 0,
      isRunning: false,
      completed: false,
      documented: false,
      priority: isHighPriority,
      estimatedTime: parseInt(newDuration) || 0,
    };
    setTasks((prev) => [...prev, task]);
    setNewTask("");
    setNewDuration("");
    setIsHighPriority(false);
  }, [newTask, newDuration, isHighPriority, currentStep.label]);

  const deferTaskToTomorrow = useCallback(() => {
    if (!newTask.trim()) return;
    const task: Task = {
      id: generateId(),
      text: newTask.trim(),
      platform: currentStep.label,
      timeSpent: 0,
      isRunning: false,
      completed: false,
      documented: false,
      priority: false,
      estimatedTime: 0,
    };
    setDeferredTasks((prev) => [...prev, task]);
    setNewTask("");
  }, [newTask, currentStep.label]);

  const deleteTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const nextStep = useCallback(() => {
    stopTriageTimer();
    setNewTask("");
    setNewDuration("");
    setIsHighPriority(false);
    const newStepsDone = [...stepsDone];
    newStepsDone[currentStepIndex] = true;
    setStepsDone(newStepsDone);
    // Persist step completion and tasks to DB
    scheduleSave({
      step1Done: newStepsDone[0],
      step2Done: newStepsDone[1],
      step3Done: newStepsDone[2],
      step4Done: newStepsDone[3],
      step5Done: newStepsDone[4],
      focusTasks: JSON.stringify(tasks),
      currentView: currentStepIndex < triageSteps.length - 1 ? "triage" : "summary",
    });
    if (currentStepIndex < triageSteps.length - 1) {
      setCurrentStepIndex((i) => i + 1);
    } else {
      setView("summary");
    }
  }, [currentStepIndex, stepsDone, tasks, stopTriageTimer, scheduleSave]);

  // ── Focus mode actions ────────────────────────────────────────────────────────
  const startTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, isRunning: true, startedAt: Date.now() }
          : { ...t, isRunning: false }
      )
    );
    setActiveTaskId(id);
    setIsIdleRunning(false);
  }, []);

  const pauseTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isRunning: false } : t))
    );
    setActiveTaskId(null);
  }, []);

  const completeTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, isRunning: false, completed: true } : t
      )
    );
    if (activeTaskId === id) setActiveTaskId(null);
  }, [activeTaskId]);

  const toggleTaskDocumentation = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, documented: !t.documented } : t))
    );
  }, []);

  const startEditingTime = useCallback((task: Task) => {
    setEditingTimeId(task.id);
    setTempTimeEdit(String(Math.floor(task.timeSpent / 60)));
  }, []);

  const saveEditingTime = useCallback(() => {
    if (!editingTimeId) return;
    const minutes = parseInt(tempTimeEdit) || 0;
    setTasks((prev) =>
      prev.map((t) => (t.id === editingTimeId ? { ...t, timeSpent: minutes * 60 } : t))
    );
    setEditingTimeId(null);
  }, [editingTimeId, tempTimeEdit]);

  // ── Copy helpers ──────────────────────────────────────────────────────────────
  const copySummaryToClipboard = useCallback(() => {
    const mainTasks = tasks.filter((t) => t.platform === "Major Tasks (APTLSS)");
    const triageTasks = tasks.filter((t) => t.platform !== "Major Tasks (APTLSS)");
    const deferred = deferredTasks;

    let text = `📋 DAILY PLAN — ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}\n\n`;
    text += `🎯 MAJOR TASKS (APTLSS):\n`;
    if (mainTasks.length === 0) text += "  None logged.\n";
    else mainTasks.forEach((t, i) => {
      text += `  ${i + 1}. ${t.priority ? "⭐ " : ""}${t.text}${t.estimatedTime > 0 ? ` (Est: ${t.estimatedTime}m)` : ""}\n`;
    });

    if (triageTasks.length > 0) {
      text += `\n📥 TRIAGE ACTIONS:\n`;
      triageTasks.forEach((t) => { text += `  • [${t.platform}] ${t.text}\n`; });
    }

    if (deferred.length > 0) {
      text += `\n⏭ DEFERRED TO TOMORROW:\n`;
      deferred.forEach((t) => { text += `  • ${t.text}\n`; });
    }

    if (dailyFeedback.trim()) {
      text += `\n💬 FEEDBACK / BLOCKERS:\n  ${dailyFeedback}\n`;
    }

    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2500);
    });
  }, [tasks, deferredTasks, dailyFeedback]);

  const copyTrelloSnippet = useCallback((task: Task) => {
    const text = `✅ STATUS UPDATE — ${new Date().toLocaleDateString("en-GB")}\nTask: ${task.text}\nTime Spent: ${formatDuration(task.timeSpent)}\nStatus: In Progress / Completed\nNext: [add next action here]`;
    navigator.clipboard.writeText(text).then(() => {
      setSnippetFeedbackId(task.id);
      setTimeout(() => setSnippetFeedbackId(null), 2000);
    });
  }, []);

  const copyEODReport = useCallback(() => {
    const totalTime = tasks.reduce((sum, t) => sum + t.timeSpent, 0);
    const completed = tasks.filter((t) => t.completed);
    const open = tasks.filter((t) => !t.completed);

    let text = `🌙 END-OF-DAY REPORT — ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}\n\n`;
    text += `⏱ Total Time Tracked: ${formatDuration(totalTime)}\n\n`;
    text += `✅ COMPLETED (${completed.length}):\n`;
    completed.forEach((t) => { text += `  • ${t.text} — ${formatDuration(t.timeSpent)}\n`; });
    if (open.length > 0) {
      text += `\n🔄 STILL OPEN (${open.length}):\n`;
      open.forEach((t) => { text += `  • ${t.text}\n`; });
    }
    if (deferredTasks.length > 0) {
      text += `\n⏭ DEFERRED TO TOMORROW:\n`;
      deferredTasks.forEach((t) => { text += `  • ${t.text}\n`; });
    }
    if (eodNotes.trim()) {
      text += `\n📝 NOTES:\n  ${eodNotes}\n`;
    }

    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2500);
    });
  }, [tasks, deferredTasks, eodNotes]);

  // ── Projected finish time ─────────────────────────────────────────────────────
  const projectedFinish = (() => {
    const remaining = tasks
      .filter((t) => !t.completed)
      .reduce((sum, t) => {
        const est = t.estimatedTime * 60;
        const spent = t.timeSpent;
        return sum + Math.max(0, est - spent);
      }, 0);
    if (remaining <= 0) return null;
    const finish = new Date(Date.now() + remaining * 1000);
    return finish.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  })();

  // ════════════════════════════════════════════════════════════════════════════
  // ── INTRO VIEW ──────────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════
  if (view === "intro") {
    const totalDeferred = deferredTasks.length;
    return (
      <div className="space-y-4">


        {/* Deferred tasks from yesterday */}
        {totalDeferred > 0 && (
          <Card className="border-0 shadow-sm border-l-4 border-l-amber-500">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <CalendarClock className="w-4 h-4 text-amber-600" />
                <h3 className="font-semibold text-sm text-foreground">Deferred from Yesterday ({totalDeferred})</h3>
              </div>
              <div className="space-y-1.5">
                {deferredTasks.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 p-2.5 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200/50 dark:border-amber-800/30">
                    <span className="text-sm text-foreground">{t.text}</span>
                    <button
                      onClick={() => {
                        setTasks((prev) => [...prev, { ...t, id: generateId(), platform: "Major Tasks (APTLSS)" }]);
                        setDeferredTasks((prev) => prev.filter((d) => d.id !== t.id));
                      }}
                      className="text-xs text-amber-700 dark:text-amber-400 hover:underline flex-shrink-0"
                    >
                      Add to today
                    </button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Workflow steps overview */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <h3 className="font-semibold text-sm text-foreground mb-4">Today's Workflow</h3>
            <div className="space-y-2">
              {[
                { step: "1", label: "Morning Ritual", desc: "Process Email → WhatsApp → Upwork → Trello → Plan tasks", icon: Sun, color: "from-amber-400 to-orange-500" },
                { step: "2", label: "Focus Mode", desc: "Track time on each task. Stay on target.", icon: Timer, color: "from-violet-500 to-purple-600" },
                { step: "3", label: "Evening Ritual", desc: "Document Trello cards. Sweep loose info.", icon: Save, color: "from-indigo-500 to-blue-600" },
                { step: "4", label: "EOD Report", desc: "Copy end-of-day summary. Reset for tomorrow.", icon: ClipboardList, color: "from-slate-600 to-slate-700" },
              ].map((item) => (
                <div key={item.step} className="flex items-center gap-3 p-3 bg-muted/40 rounded-lg">
                  <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${item.color} flex items-center justify-center flex-shrink-0`}>
                    <item.icon className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-foreground">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold text-muted-foreground flex-shrink-0 cursor-default select-none">{item.step}</span>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        <p>Step {item.step} of 4</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Quick-jump step selector */}
        <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-xl border border-border/40">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide pl-2 pr-1 shrink-0">Jump to:</span>
          {[
            { label: "Morning Ritual", icon: Sun, color: "text-amber-500", action: () => { setCurrentStepIndex(0); setView("triage"); scheduleSave({ currentView: "triage" }); } },
            { label: "Focus Mode", icon: Timer, color: "text-violet-500", action: () => { setView("focus_mode"); scheduleSave({ currentView: "focus_mode", focusTasks: JSON.stringify(tasks) }); } },
            { label: "Evening Ritual", icon: Moon, color: "text-indigo-500", action: () => { setView("evening_review"); scheduleSave({ currentView: "evening_review" }); } },
            { label: "EOD Report", icon: ClipboardList, color: "text-slate-500", action: () => { setView("evening_summary"); scheduleSave({ currentView: "evening_summary" }); } },
          ].map((item) => (
            <button
              key={item.label}
              onClick={item.action}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-background transition-all duration-150 min-w-0"
            >
              <item.icon className={`w-3.5 h-3.5 shrink-0 ${item.color}`} />
              <span className="truncate hidden sm:inline">{item.label}</span>
              <span className="truncate sm:hidden">{item.label.split(" ")[0]}</span>
            </button>
          ))}
        </div>

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-3">
          <Button
            onClick={() => { setCurrentStepIndex(0); setView("triage"); scheduleSave({ currentView: "triage" }); }}
            className="bg-gradient-to-r from-slate-800 to-slate-900 hover:from-slate-700 hover:to-slate-800 text-white h-12 text-sm font-semibold"
          >
            <Sun className="w-4 h-4 mr-2 text-amber-400" />
            Morning Ritual
          </Button>
          <Button
            onClick={() => { setView("evening_review"); scheduleSave({ currentView: "evening_review" }); }}
            variant="outline"
            className="h-12 text-sm font-medium"
          >
            <Moon className="w-4 h-4 mr-2" />
            Evening Ritual
          </Button>
        </div>

        {tasks.length > 0 && (
          <Button
            onClick={() => { setView("focus_mode"); scheduleSave({ currentView: "focus_mode", focusTasks: JSON.stringify(tasks) }); }}
            variant="outline"
            className="w-full h-10 text-sm border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/20"
          >
            <Timer className="w-4 h-4 mr-2" />
            Resume Focus Mode ({tasks.filter((t) => !t.completed).length} tasks remaining)
          </Button>
        )}

        {/* Resume last saved view (only shown when there is a non-intro saved view that isn't focus_mode — that's already handled above) */}
        {savedState?.currentView &&
          savedState.currentView !== "intro" &&
          savedState.currentView !== "focus_mode" && (
          <Button
            onClick={() => setView(savedState.currentView as View)}
            variant="ghost"
            className="w-full h-9 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Resume where you left off (
            {savedState.currentView === "triage" ? "Morning Ritual" :
             savedState.currentView === "summary" ? "Morning Summary" :
             savedState.currentView === "evening_review" ? "Evening Ritual" :
             savedState.currentView === "evening_summary" ? "Evening Summary" :
             savedState.currentView})
          </Button>
        )}

        {/* ── Past EOD Reports (last 7 days) ─────────────────────────────── */}
        {recentReports && recentReports.length > 0 && (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-0">
              <Accordion type="single" collapsible>
                <AccordionItem value="past-reports" className="border-0">
                  <AccordionTrigger className="px-5 py-3 hover:no-underline">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-muted-foreground" />
                      <span className="font-semibold text-sm text-foreground">Past EOD Reports</span>
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-1">{recentReports.length}</Badge>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-5 pb-4">
                    <div className="space-y-3">
                      {recentReports.map((report) => (
                        <div key={new Date(report.triageDate).toISOString()} className="border border-border/50 rounded-lg p-3">
                          <p className="text-xs font-semibold text-muted-foreground mb-1.5">
                            {new Date(report.triageDate).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                          </p>
                          <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{report.eodReport}</p>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ── TRIAGE VIEW ─────────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════
  if (view === "triage") {
    return (
      <div className="space-y-4">
        {/* Progress dots */}
        <div className="flex justify-center gap-2">
          {triageSteps.map((step, idx) => (
            <div
              key={step.id}
              className={`h-2 rounded-full transition-all duration-300 ${
                idx < currentStepIndex
                  ? "w-6 bg-emerald-500"
                  : idx === currentStepIndex
                  ? "w-8 bg-slate-800 dark:bg-slate-200"
                  : "w-2 bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Step card */}
        <Card className={`border-0 shadow-sm overflow-hidden border-t-4 ${currentStep.borderColor}`}>
          <div className={`p-5 ${currentStep.color} flex items-center justify-between border-b border-border/30`}>
            <div className="flex items-center gap-3">
              <div className="bg-white dark:bg-slate-800 p-2.5 rounded-xl shadow-sm">
                {currentStep.icon}
              </div>
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Step {currentStepIndex + 1} of {triageSteps.length}
                </p>
                <h2 className="text-base font-bold text-foreground">{currentStep.label}</h2>
              </div>
            </div>
            <a
              href={currentStep.link}
              target="_blank"
              rel="noreferrer"
              className="bg-white/60 dark:bg-white/10 hover:bg-white dark:hover:bg-white/20 p-2 rounded-lg text-muted-foreground transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>

          <CardContent className="p-5 space-y-4">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {currentStep.instruction}
              {currentStep.type === "planning" && (
                <span className="block mt-1 font-semibold text-purple-600 dark:text-purple-400">
                  Look for the "Doing" designation.
                </span>
              )}
            </p>

            {/* Planning: open Trello button */}
            {currentStep.type === "planning" && (
              <a
                href={currentStep.link}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 w-full py-2.5 bg-purple-100 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300 rounded-lg font-medium text-sm hover:bg-purple-200 dark:hover:bg-purple-950/50 transition-colors border border-purple-200 dark:border-purple-800/50"
              >
                <ListTodo className="w-4 h-4" /> Open My Assigned Cards
              </a>
            )}

            {/* Triage: 2-min timer */}
            {currentStep.type === "triage" && (
              <div className={`border-2 rounded-xl p-4 transition-all ${isTriageTimerActive ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20" : "border-border bg-muted/30"}`}>
                <div className="flex justify-between items-center mb-2">
                  <h3 className="font-semibold text-sm text-foreground">Quick Action (&lt; 2 min)</h3>
                  {isTriageTimerActive && (
                    <span className="text-emerald-700 dark:text-emerald-400 font-mono font-bold text-sm">
                      {formatTriageTime(triageTimeLeft)}
                    </span>
                  )}
                </div>
                {isTriageTimerActive ? (
                  <Button onClick={stopTriageTimer} variant="outline" size="sm" className="w-full border-emerald-300 text-emerald-700">
                    <CheckCircle className="w-3.5 h-3.5 mr-1.5" /> Done
                  </Button>
                ) : (
                  <Button onClick={startTriageTimer} variant="outline" size="sm" className="w-full">
                    <Timer className="w-3.5 h-3.5 mr-1.5" /> Start 2-min Timer
                  </Button>
                )}
              </div>
            )}

            {/* Task input */}
            <div className={`border-2 rounded-xl p-4 ${currentStep.type === "planning" ? "border-purple-200 dark:border-purple-800/50 bg-purple-50/50 dark:bg-purple-950/10" : "border-border bg-muted/20"}`}>
              <h3 className="font-semibold text-sm text-foreground mb-3">
                {currentStep.type === "planning" ? "Log 'Doing' Task" : "Action Required (> 2 min)"}
              </h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  placeholder={currentStep.type === "planning" ? "Task name from Trello..." : "Describe the action..."}
                  className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring min-w-0"
                  onKeyDown={(e) => e.key === "Enter" && addTaskToToday()}
                />
                {currentStep.type === "planning" && (
                  <input
                    type="number"
                    value={newDuration}
                    onChange={(e) => setNewDuration(e.target.value)}
                    placeholder="Est"
                    className="w-16 px-2 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring text-center"
                  />
                )}
                {currentStep.type === "planning" && (
                  <button
                    onClick={() => setIsHighPriority(!isHighPriority)}
                    className={`flex-shrink-0 px-2.5 py-2 rounded-lg border transition-colors ${isHighPriority ? "bg-red-100 dark:bg-red-950/30 border-red-300 dark:border-red-800 text-red-600" : "border-border text-muted-foreground hover:text-foreground"}`}
                  >
                    <Star className={`w-4 h-4 ${isHighPriority ? "fill-current" : ""}`} />
                  </button>
                )}
                <button
                  onClick={addTaskToToday}
                  disabled={!newTask.trim()}
                  className="flex-shrink-0 bg-foreground text-background px-3 py-2 rounded-lg hover:opacity-80 disabled:opacity-40 transition-opacity"
                >
                  <Plus className="w-4 h-4" />
                </button>
                {currentStep.type === "triage" && (
                  <button
                    onClick={deferTaskToTomorrow}
                    disabled={!newTask.trim()}
                    className="flex-shrink-0 bg-amber-100 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-800 px-2.5 py-2 rounded-lg hover:bg-amber-200 disabled:opacity-40 transition-colors"
                    title="Defer to tomorrow"
                  >
                    <CalendarClock className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Task list */}
              {tasks.filter((t) => t.platform === currentStep.label).length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {tasks.filter((t) => t.platform === currentStep.label).map((task) => (
                    <li
                      key={task.id}
                      className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-sm ${
                        task.priority
                          ? "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800/50 text-red-800 dark:text-red-300"
                          : "bg-background border-border text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {task.priority && <Star className="w-3.5 h-3.5 text-red-500 fill-current flex-shrink-0" />}
                        <span className="truncate">{task.text}</span>
                        {task.estimatedTime > 0 && (
                          <span className="text-muted-foreground text-xs flex-shrink-0">({task.estimatedTime}m)</span>
                        )}
                      </div>
                      <button onClick={() => deleteTask(task.id)} className="text-muted-foreground/50 hover:text-red-500 flex-shrink-0 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Next step button */}
            <Button
              onClick={nextStep}
              className="w-full bg-foreground text-background hover:opacity-80 h-11 font-semibold"
            >
              {currentStepIndex === triageSteps.length - 1 ? "Finish & View Summary" : "Next Step"}
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ── SUMMARY VIEW ────────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════
  if (view === "summary") {
    const mainTasks = tasks.filter((t) => t.platform === "Major Tasks (APTLSS)");
    const triageTasks = tasks.filter((t) => t.platform !== "Major Tasks (APTLSS)");

    return (
      <div className="space-y-4">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
                <CheckCircle className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-base font-bold text-foreground">Triage Complete</h2>
                <p className="text-xs text-muted-foreground">Plan is ready. Time to execute.</p>
              </div>
            </div>

            {mainTasks.length > 0 && (
              <div className="mb-4">
                <h3 className="font-semibold text-sm text-foreground mb-2">Major Tasks Today</h3>
                <div className="space-y-1.5">
                  {mainTasks.map((t) => (
                    <div key={t.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${t.priority ? "bg-red-50 dark:bg-red-950/20 border border-red-200/50 dark:border-red-800/30" : "bg-muted/40"}`}>
                      {t.priority && <Star className="w-3.5 h-3.5 text-red-500 fill-current flex-shrink-0" />}
                      <span className="flex-1 text-foreground">{t.text}</span>
                      {t.estimatedTime > 0 && <span className="text-xs text-muted-foreground">{t.estimatedTime}m</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {triageTasks.length > 0 && (
              <div className="mb-4">
                <h3 className="font-semibold text-sm text-foreground mb-2">Triage Actions Logged</h3>
                <div className="space-y-1">
                  {triageTasks.map((t) => (
                    <div key={t.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 text-sm">
                      <span className="text-muted-foreground text-xs">[{t.platform}]</span>
                      <span className="text-foreground">{t.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Feedback textarea */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <MessageSquareWarning className="w-4 h-4 text-orange-500" />
                <h3 className="font-semibold text-sm text-foreground">Daily Feedback / Blockers</h3>
              </div>
              <textarea
                value={dailyFeedback}
                onChange={(e) => setDailyFeedback(e.target.value)}
                placeholder="E.g. 'Too many notifications today', 'Stuck on blog post', or 'Feeling good!'"
                className="w-full p-3 border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring text-sm h-20 resize-none"
              />
            </div>

            <div className="space-y-2">
              <Button
                onClick={() => setView("focus_mode")}
                className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white h-11 font-semibold"
              >
                <Timer className="w-4 h-4 mr-2 text-yellow-300" /> Enter Focus Mode
              </Button>
              <Button
                onClick={copySummaryToClipboard}
                variant="outline"
                className={`w-full h-10 text-sm ${copyFeedback ? "border-emerald-300 text-emerald-700 bg-emerald-50 dark:bg-emerald-950/20" : ""}`}
              >
                {copyFeedback ? <CheckCircle className="w-4 h-4 mr-2" /> : <ClipboardList className="w-4 h-4 mr-2" />}
                {copyFeedback ? "Copied!" : "Copy Daily Plan Report"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ── FOCUS MODE VIEW ─────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════
  if (view === "focus_mode") {
    const activeTasks = tasks.filter((t) => !t.completed);
    const completedTasks = tasks.filter((t) => t.completed);
    const totalTracked = tasks.reduce((sum, t) => sum + t.timeSpent, 0);

    return (
      <div className="space-y-4">
        {/* Header stats */}
        <div className="grid grid-cols-3 gap-3">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Tracked</p>
              <p className="text-lg font-bold text-foreground font-mono">{formatDuration(totalTracked)}</p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Remaining</p>
              <p className="text-lg font-bold text-foreground">{activeTasks.length} tasks</p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Est. Finish</p>
              <p className="text-lg font-bold text-foreground">{projectedFinish ?? "—"}</p>
            </CardContent>
          </Card>
        </div>

        {/* Idle warning */}
        {isIdleRunning && idleTime > 30 && (
          <div className="flex items-center gap-2.5 p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Idle for {formatDuration(idleTime)}. Start a task to track time.
            </p>
          </div>
        )}

        {/* Active tasks */}
        {activeTasks.length > 0 && (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <h3 className="font-semibold text-sm text-foreground mb-3">Active Tasks</h3>
              <div className="space-y-2">
                {activeTasks.map((task) => (
                  <div
                    key={task.id}
                    className={`p-3.5 rounded-xl border-2 transition-all ${
                      task.isRunning
                        ? "border-violet-400 bg-violet-50 dark:bg-violet-950/20"
                        : "border-border bg-muted/20"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {task.priority && <Star className="w-3.5 h-3.5 text-red-500 fill-current flex-shrink-0" />}
                          <p className="font-medium text-sm text-foreground truncate">{task.text}</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{task.platform}</p>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {task.isRunning ? (
                          <button
                            onClick={() => pauseTask(task.id)}
                            className="p-1.5 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400 rounded-lg hover:bg-violet-200 transition-colors"
                          >
                            <Pause className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            onClick={() => startTask(task.id)}
                            className="p-1.5 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg hover:bg-emerald-200 transition-colors"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => completeTask(task.id)}
                          className="p-1.5 bg-muted text-muted-foreground rounded-lg hover:bg-emerald-100 hover:text-emerald-700 transition-colors"
                          title="Mark complete"
                        >
                          <CheckCircle className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className={`font-mono font-bold ${task.isRunning ? "text-violet-600 dark:text-violet-400" : "text-muted-foreground"}`}>
                        {formatDuration(task.timeSpent)}
                        {task.estimatedTime > 0 && <span className="text-muted-foreground font-normal"> / {task.estimatedTime}m est</span>}
                      </span>
                      {task.estimatedTime > 0 && (
                        <div className="flex-1 mx-3 bg-muted rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-violet-500 to-purple-500 rounded-full transition-all"
                            style={{ width: `${Math.min((task.timeSpent / (task.estimatedTime * 60)) * 100, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Completed tasks */}
        {completedTasks.length > 0 && (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <h3 className="font-semibold text-sm text-foreground mb-3">
                Completed ({completedTasks.length})
              </h3>
              <div className="space-y-1.5">
                {completedTasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-2.5 px-3 py-2 bg-emerald-50 dark:bg-emerald-950/20 rounded-lg border border-emerald-200/50 dark:border-emerald-800/30">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                    <span className="text-sm text-emerald-800 dark:text-emerald-300 flex-1 line-through">{task.text}</span>
                    <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400">{formatDuration(task.timeSpent)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {activeTasks.length === 0 && (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-8 text-center">
              <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
              <h3 className="font-bold text-foreground mb-1">All Tasks Complete!</h3>
              <p className="text-sm text-muted-foreground">Great work. Time for the evening ritual.</p>
            </CardContent>
          </Card>
        )}

        <Button
          onClick={() => setView("evening_review")}
          className="w-full bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 text-white h-11 font-semibold"
        >
          <Moon className="w-4 h-4 mr-2" /> Start Evening Ritual
        </Button>
        <Button onClick={() => setView("intro")} variant="ghost" className="w-full text-sm text-muted-foreground h-9">
          ← Back to Home
        </Button>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ── EVENING REVIEW VIEW ─────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════
  if (view === "evening_review") {
    const aptlssTasks = tasks.filter((t) => t.platform === "Major Tasks (APTLSS)");

    return (
      <div className="space-y-4">
        <Card className="border-0 shadow-sm overflow-hidden border-t-4 border-indigo-400">
          <div className="p-5 bg-indigo-50 dark:bg-indigo-950/30 border-b border-indigo-100 dark:border-indigo-900/50 flex items-center gap-3">
            <div className="bg-white dark:bg-slate-800 p-2.5 rounded-xl shadow-sm">
              <Save className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-foreground">Evening Ritual</h2>
              <p className="text-xs text-muted-foreground">Review output & document progress.</p>
            </div>
          </div>

          <CardContent className="p-5 space-y-5">
            {/* Trello documentation */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <ListTodo className="w-4 h-4 text-foreground" />
                <h3 className="font-semibold text-sm text-foreground">Update Cards & Validate Time</h3>
              </div>
              <p className="text-xs text-muted-foreground mb-3">Click "Copy Snippet" to get a status update for Trello.</p>

              {aptlssTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No major tasks logged today.</p>
              ) : (
                <div className="space-y-2">
                  {aptlssTasks.map((task) => (
                    <div
                      key={task.id}
                      className={`p-3.5 rounded-xl border-2 transition-all ${task.documented ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20" : "border-border bg-muted/20"}`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => toggleTaskDocumentation(task.id)}>
                          <p className={`font-medium text-sm break-words ${task.documented ? "text-emerald-800 dark:text-emerald-300" : "text-foreground"}`}>
                            {task.text}
                          </p>
                        </div>
                        <div
                          className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center cursor-pointer ${task.documented ? "border-emerald-500 bg-emerald-500 text-white" : "border-muted-foreground"}`}
                          onClick={() => toggleTaskDocumentation(task.id)}
                        >
                          {task.documented && <CheckCircle className="w-3.5 h-3.5" />}
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs border-t border-border/50 pt-2">
                        {editingTimeId === task.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              value={tempTimeEdit}
                              onChange={(e) => setTempTimeEdit(e.target.value)}
                              className="w-14 px-2 py-1 border border-border rounded bg-background text-sm"
                              autoFocus
                            />
                            <span className="text-muted-foreground">min</span>
                            <button onClick={saveEditingTime} className="text-emerald-600 font-bold hover:underline text-xs">Save</button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-indigo-600 dark:text-indigo-400 font-bold">
                              {formatDuration(task.timeSpent)}
                            </span>
                            {task.estimatedTime > 0 && (
                              <span className="text-muted-foreground">/ {task.estimatedTime}m est</span>
                            )}
                            <button
                              onClick={() => startEditingTime(task)}
                              className="p-1 text-muted-foreground/50 hover:text-indigo-500 rounded transition-colors"
                              title="Edit time"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); copyTrelloSnippet(task); }}
                          className={`flex items-center gap-1 px-2 py-1 rounded transition-colors text-xs font-medium ${snippetFeedbackId === task.id ? "bg-emerald-100 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
                        >
                          {snippetFeedbackId === task.id ? <CheckCircle className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          Copy Snippet
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Loose info sweep */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-foreground" />
                <h3 className="font-semibold text-sm text-foreground">Loose Info Sweep</h3>
              </div>
              <p className="text-xs text-muted-foreground mb-3">Did you receive new info via WhatsApp/Email today? Don't leave it there.</p>
              <label className="flex items-center gap-3 p-3 bg-muted/40 rounded-lg border border-border cursor-pointer hover:bg-muted/60 transition-colors">
                <input type="checkbox" className="w-4 h-4 rounded accent-indigo-600" />
                <span className="text-sm text-foreground">I have moved all new loose info into Trello Cards.</span>
              </label>
            </div>

            <Button
              onClick={() => { setView("evening_summary"); scheduleSave({ currentView: "evening_summary", eveningStep1Done: true, eveningStep2Done: true, eveningStep3Done: true, eveningStep4Done: true }); }}
              className="w-full bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 text-white h-11 font-semibold"
            >
              Review Complete <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ── EVENING SUMMARY VIEW ────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════
  if (view === "evening_summary") {
    return (
      <div className="space-y-4">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center mx-auto mb-4 shadow-md">
              <Moon className="w-7 h-7 text-white" />
            </div>
            <h2 className="text-xl font-bold text-foreground mb-1">Day Closed</h2>
            <p className="text-sm text-muted-foreground">Output velocity tracked.</p>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <h3 className="font-semibold text-sm text-foreground mb-3">Final Notes (Optional)</h3>
            <textarea
              value={eodNotes}
              onChange={(e) => { setEodNotes(e.target.value); scheduleSave({ eodReport: e.target.value }); }}
              placeholder="Any struggles today? Needs for tomorrow?"
              className="w-full p-3 border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring text-sm h-24 resize-none"
            />
          </CardContent>
        </Card>

        <div className="space-y-2">
          <Button
            onClick={copyEODReport}
            variant="outline"
            className={`w-full h-11 font-medium ${copyFeedback ? "border-emerald-300 text-emerald-700 bg-emerald-50 dark:bg-emerald-950/20" : ""}`}
          >
            {copyFeedback ? <CheckCircle className="w-4 h-4 mr-2" /> : <ClipboardList className="w-4 h-4 mr-2" />}
            {copyFeedback ? "Copied to Clipboard!" : "Copy End-of-Day Report"}
          </Button>

          <Button
            onClick={() => {
              setTasks([]);
              setDeferredTasks(deferredTasks);
              setIdleTime(0);
              setView("intro");
            }}
            variant="ghost"
            className="w-full text-sm text-muted-foreground h-9"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reset for Tomorrow
          </Button>
        </div>
      </div>
    );
  }

  return null;
}


