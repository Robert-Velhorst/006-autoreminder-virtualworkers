import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InfoTooltip } from "@/components/manus/InfoTooltip";
import {
  Monitor, FolderOpen, Laptop, Inbox, RefreshCw, HardDrive,
  ListTodo, Battery, Target, CheckCircle2, Circle,
  Columns3, Mail, MessageSquare, Briefcase, Clock
} from "lucide-react";

// Get the relevant Sunday for the checklist:
// - If today IS Sunday → use today
// - If today is Saturday → use tomorrow (upcoming Sunday, the day you'd do this)
// - Otherwise → use the upcoming Sunday (next week)
function getRelevantSunday(): string {
  const today = new Date();
  const day = today.getDay(); // 0 = Sunday, 6 = Saturday
  let diff: number;
  if (day === 0) {
    diff = 0; // today is Sunday
  } else if (day === 6) {
    diff = 1; // tomorrow is Sunday
  } else {
    diff = 7 - day; // days until next Sunday
  }
  const sunday = new Date(today);
  sunday.setDate(today.getDate() + diff);
  return sunday.toISOString().slice(0, 10);
}

type ChecklistKey =
  | "trelloArchived" | "trelloLabels" | "trelloDeadlines" | "trelloTimers"
  | "emailInbox" | "whatsappCleared" | "upworkArchived"
  | "downloadsCleared" | "desktopCleared" | "browserTabsClosed"
  | "weekReviewed" | "nextWeekPlanned";

interface ChecklistItem {
  key: ChecklistKey;
  icon: React.ElementType;
  title: string;
  desc: string;
  color: string;
  group: string;
}

const CHECKLIST_ITEMS: ChecklistItem[] = [
  // Trello
  { key: "trelloArchived", icon: CheckCircle2, title: "Archive Completed Cards", desc: "Move all done cards to the Archive list or delete them. Keep the board clean.", color: "from-blue-500 to-blue-600", group: "Trello Maintenance" },
  { key: "trelloLabels", icon: CheckCircle2, title: "Review Labels", desc: "Ensure all active cards have the correct labels. Remove outdated labels.", color: "from-blue-500 to-blue-600", group: "Trello Maintenance" },
  { key: "trelloDeadlines", icon: CheckCircle2, title: "Update Due Dates", desc: "Review all cards with due dates. Update or remove stale deadlines.", color: "from-blue-500 to-blue-600", group: "Trello Maintenance" },
  { key: "trelloTimers", icon: Clock, title: "Review Time Logs", desc: "Check timer logs for the week. Ensure all worked cards have accurate time entries.", color: "from-blue-500 to-blue-600", group: "Trello Maintenance" },
  // Communication
  { key: "emailInbox", icon: Mail, title: "Clear Email Inbox", desc: "Delete spam, archive read emails, unsubscribe from unused lists.", color: "from-amber-500 to-amber-600", group: "Communication" },
  { key: "whatsappCleared", icon: MessageSquare, title: "Clear WhatsApp", desc: "Archive or delete old chats. Ensure no unread messages remain.", color: "from-amber-500 to-amber-600", group: "Communication" },
  { key: "upworkArchived", icon: Briefcase, title: "Archive Upwork Conversations", desc: "Archive inactive Upwork conversations. Keep only active clients visible.", color: "from-amber-500 to-amber-600", group: "Communication" },
  // Files & System
  { key: "downloadsCleared", icon: FolderOpen, title: "Clear Downloads Folder", desc: "Delete used files, duplicates, and temp files. Move important docs to proper folders.", color: "from-violet-500 to-violet-600", group: "Files & System" },
  { key: "desktopCleared", icon: Laptop, title: "Organise Desktop", desc: "Delete unused shortcuts. Move files to Documents/Pictures. Keep desktop clean.", color: "from-violet-500 to-violet-600", group: "Files & System" },
  { key: "browserTabsClosed", icon: Monitor, title: "Close Browser Tabs", desc: "Close unnecessary tabs. Bookmark or save important info before closing.", color: "from-violet-500 to-violet-600", group: "Files & System" },
  // Review
  { key: "weekReviewed", icon: ListTodo, title: "Review the Week", desc: "Reflect on what went well and what didn't. Note any patterns or recurring issues.", color: "from-emerald-500 to-emerald-600", group: "Weekly Review" },
  { key: "nextWeekPlanned", icon: Target, title: "Plan Next Week", desc: "Identify top 3 priorities. Note deadlines and upcoming tasks. Start Monday focused.", color: "from-emerald-500 to-emerald-600", group: "Weekly Review" },
];

const GROUPS = ["Trello Maintenance", "Communication", "Files & System", "Weekly Review"];

type ChecklistState = Record<ChecklistKey, boolean>;

const DEFAULT_STATE: ChecklistState = {
  trelloArchived: false, trelloLabels: false, trelloDeadlines: false, trelloTimers: false,
  emailInbox: false, whatsappCleared: false, upworkArchived: false,
  downloadsCleared: false, desktopCleared: false, browserTabsClosed: false,
  weekReviewed: false, nextWeekPlanned: false,
};

export default function SundayChecklist() {
  const sundayDate = getRelevantSunday();
  const [state, setState] = useState<ChecklistState>(DEFAULT_STATE);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: savedState } = trpc.sunday.getByDate.useQuery({ date: sundayDate });
  const upsert = trpc.sunday.upsert.useMutation();

  // Load saved state from DB on mount
  useEffect(() => {
    if (savedState) {
      setState({
        trelloArchived: savedState.trelloArchived ?? false,
        trelloLabels: savedState.trelloLabels ?? false,
        trelloDeadlines: savedState.trelloDeadlines ?? false,
        trelloTimers: savedState.trelloTimers ?? false,
        emailInbox: savedState.emailInbox ?? false,
        whatsappCleared: savedState.whatsappCleared ?? false,
        upworkArchived: savedState.upworkArchived ?? false,
        downloadsCleared: savedState.downloadsCleared ?? false,
        desktopCleared: savedState.desktopCleared ?? false,
        browserTabsClosed: savedState.browserTabsClosed ?? false,
        weekReviewed: savedState.weekReviewed ?? false,
        nextWeekPlanned: savedState.nextWeekPlanned ?? false,
      });
    }
  }, [savedState]);

  function scheduleSave(newState: ChecklistState) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      upsert.mutate({ sundayDate, ...newState });
    }, 800);
  }

  function toggle(key: ChecklistKey) {
    setState(prev => {
      const next = { ...prev, [key]: !prev[key] };
      scheduleSave(next);
      return next;
    });
  }

  const completedCount = Object.values(state).filter(Boolean).length;
  const totalCount = CHECKLIST_ITEMS.length;
  const allDone = completedCount === totalCount;

  const groupColorMap: Record<string, string> = {
    "Trello Maintenance": "from-blue-500 to-blue-600",
    "Communication": "from-amber-500 to-amber-600",
    "Files & System": "from-violet-500 to-violet-600",
    "Weekly Review": "from-emerald-500 to-emerald-600",
  };

  const groupBgMap: Record<string, string> = {
    "Trello Maintenance": "bg-blue-500/10 border-blue-500/20",
    "Communication": "bg-amber-500/10 border-amber-500/20",
    "Files & System": "bg-violet-500/10 border-violet-500/20",
    "Weekly Review": "bg-emerald-500/10 border-emerald-500/20",
  };

  return (
    <div className="space-y-4">
      {/* Header Card */}
      <Card className="border-0 shadow-sm overflow-hidden">
        <div className={`bg-gradient-to-r ${allDone ? "from-emerald-500 to-green-600" : "from-slate-600 to-slate-700"} p-5 text-white`}>
          <div className="flex items-center gap-2.5 mb-3">
            <Battery className="w-5 h-5" />
            <h2 className="text-base font-bold">Sunday Maintenance</h2>
            <InfoTooltip
              content="This is for your personal laptop, not the remote work PC. Take 1-2 hours to maintain your workspace. Sunday is also for rest — balance these tasks with relaxation, family time, and hobbies."
              className="ml-1 text-white/70 hover:text-white"
            />
            <Badge className="bg-white/20 text-white border-0 text-[10px] ml-auto">
              {completedCount}/{totalCount} done
            </Badge>
          </div>

          <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">
                {allDone ? "✓ All tasks complete!" : `${totalCount - completedCount} tasks remaining`}
              </p>
              <p className="text-xs opacity-70">
                {(() => {
                  const d = new Date(sundayDate + "T12:00:00");
                  const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                  const today = new Date();
                  today.setHours(0,0,0,0);
                  const isUpcoming = d.getTime() > today.getTime();
                  return isUpcoming ? `Upcoming: ${label}` : label;
                })()}
              </p>
            </div>
            <div className="w-full h-2 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full transition-all duration-500"
                style={{ width: `${(completedCount / totalCount) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Checklist by Group */}
      {GROUPS.map(group => {
        const items = CHECKLIST_ITEMS.filter(i => i.group === group);
        const groupDone = items.filter(i => state[i.key]).length;
        return (
          <Card key={group} className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center gap-2.5 mb-3">
                <div className={`w-1 h-6 rounded-full bg-gradient-to-b ${groupColorMap[group]}`}></div>
                <h3 className="text-sm font-bold text-foreground">{group}</h3>
                <Badge variant="secondary" className="text-[10px] ml-auto">
                  {groupDone}/{items.length}
                </Badge>
              </div>

              <div className="space-y-1.5">
                {items.map(item => {
                  const done = state[item.key];
                  return (
                    <button
                      key={item.key}
                      onClick={() => toggle(item.key)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all duration-200 text-left ${
                        done
                          ? `${groupBgMap[group]} border`
                          : "bg-muted/40 hover:bg-muted/60 border border-transparent"
                      }`}
                    >
                      {done ? (
                        <CheckCircle2 className={`w-5 h-5 flex-shrink-0 ${
                          group === "Trello Maintenance" ? "text-blue-500" :
                          group === "Communication" ? "text-amber-500" :
                          group === "Files & System" ? "text-violet-500" : "text-emerald-500"
                        }`} />
                      ) : (
                        <Circle className="w-5 h-5 flex-shrink-0 text-muted-foreground" />
                      )}
                      <span className={`text-sm font-medium flex-1 ${done ? "line-through text-muted-foreground" : "text-foreground"}`}>
                        {item.title}
                      </span>
                      <InfoTooltip content={item.desc} side="left" />
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
