import { useEffect, useMemo, useState } from "react";
import {
  BellRing,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  History,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type Dashboard = RouterOutputs["reminders"]["dashboard"];
type ReminderRow = Dashboard["rows"][number];

const ACTIVE_STATES = new Set(["scheduled", "preparing", "draft_ready", "sending", "failed", "needs_review", "escalated"]);
const DEFAULT_ACTIVE_LIMIT = 10;

function dateTimeInputValue(date = new Date(Date.now() + 60 * 60_000)) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function stateTone(state: string) {
  if (state === "sent") return "border-emerald-500/30 text-emerald-600 dark:text-emerald-300";
  if (state === "failed" || state === "needs_review" || state === "escalated") return "border-red-500/30 text-red-600 dark:text-red-300";
  if (state === "draft_ready") return "border-amber-500/30 text-amber-600 dark:text-amber-300";
  return "border-blue-500/30 text-blue-600 dark:text-blue-300";
}

function stateLabel(state: string) {
  return state.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function WorkerReminders() {
  const utils = trpc.useUtils();
  const dashboard = trpc.reminders.dashboard.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const [selected, setSelected] = useState<ReminderRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showAllActive, setShowAllActive] = useState(false);
  const rows = dashboard.data?.rows ?? [];
  const active = useMemo(() => rows.filter((row) => row.commitment.status === "open" && ACTIVE_STATES.has(row.schedule.state)), [rows]);
  const history = useMemo(() => rows.filter((row) => !ACTIVE_STATES.has(row.schedule.state) || row.commitment.status !== "open"), [rows]);

  const refresh = async () => {
    await utils.reminders.dashboard.invalidate();
  };

  if (dashboard.isLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center" role="status"><Loader2 className="size-6 animate-spin text-muted-foreground" /><span className="sr-only">Loading reminders</span></div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div><h1 className="text-2xl font-semibold">Reminders</h1></div>
        <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={dashboard.isFetching} aria-label="Refresh reminders"><RefreshCw className={`size-4 ${dashboard.isFetching ? "animate-spin" : ""}`} /></Button>
      </div>

      {dashboard.error && <Alert variant="destructive"><CircleAlert className="size-4" /><AlertTitle>Reminder system unavailable</AlertTitle><AlertDescription>{dashboard.error.message} Retry is safe; no reminder was sent.</AlertDescription></Alert>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <CreateReminderPanel onCreated={refresh} />
          <section aria-labelledby="active-reminders-title" className="overflow-hidden rounded-lg border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div><h2 id="active-reminders-title" className="font-semibold">Upcoming reminders</h2></div>
              <Badge variant="outline">{active.length}</Badge>
            </div>
            {active.length === 0 ? (
              <div className="px-4 py-10 text-center"><ShieldCheck className="mx-auto mb-3 size-5 text-emerald-500" /><p className="font-medium">No reminder needs attention</p><p className="mt-1 text-sm text-muted-foreground">New commitments appear here when they become due.</p></div>
            ) : (
              <>
                <div className="divide-y">
                  {(showAllActive ? active : active.slice(0, DEFAULT_ACTIVE_LIMIT)).map((row) => <ReminderQueueRow key={row.schedule.id} row={row} onSelect={() => setSelected(row)} />)}
                </div>
                {active.length > DEFAULT_ACTIVE_LIMIT && <div className="border-t p-3">
                  <Button className="w-full" variant="ghost" onClick={() => setShowAllActive((value) => !value)}>
                    {showAllActive ? "Show fewer reminders" : `Show ${active.length - DEFAULT_ACTIVE_LIMIT} more reminders`}
                  </Button>
                </div>}
              </>
            )}
          </section>

          <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="overflow-hidden rounded-lg border">
            <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent/40">
              <span className="flex items-center gap-2"><History className="size-4 text-muted-foreground" /><span><span className="block font-semibold">Recent history</span><span className="block text-xs text-muted-foreground">Sent, skipped, completed, and cancelled records</span></span></span>
              <span className="flex items-center gap-2"><Badge variant="outline">{history.length}</Badge><ChevronDown className={`size-4 transition-transform ${historyOpen ? "rotate-180" : ""}`} /></span>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t">
              {history.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">No completed reminder history yet.</p> : <div className="divide-y">{history.slice(0, 50).map((row) => <ReminderQueueRow key={row.schedule.id} row={row} onSelect={() => setSelected(row)} />)}</div>}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <aside className="space-y-4">
          <ReminderPolicyPanel dashboard={dashboard.data} onSaved={refresh} />
          <section className="rounded-lg border p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4 text-emerald-500" />Delivery safeguards</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <PolicyLine label="Email" value="Approval required" />
              <PolicyLine label="Duplicate sends" value="Blocked" />
              <PolicyLine label="Interrupted sends" value="Review required" />
              <PolicyLine label="Delivery history" value={`${dashboard.data?.audit.length ?? 0} recent events`} />
            </dl>
          </section>
        </aside>
      </div>

      <ReminderReviewSheet row={selected} onClose={() => setSelected(null)} onChanged={async () => { setSelected(null); await refresh(); }} />
    </div>
  );
}

function CreateReminderPanel({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [dueAt, setDueAt] = useState(dateTimeInputValue());
  const [offsetMinutes, setOffsetMinutes] = useState(60);
  const [channel, setChannel] = useState<"in_app" | "email">("in_app");
  const create = trpc.reminders.create.useMutation({
    onSuccess: async () => {
      toast.success("Commitment scheduled");
      setTitle(""); setContext(""); setDueAt(dateTimeInputValue()); setOpen(false);
      await onCreated();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent/40">
        <span className="flex items-center gap-2"><Plus className="size-4 text-blue-500" /><span><span className="block font-semibold">Add commitment</span><span className="block text-xs text-muted-foreground"></span></span></span>
        <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t p-4">
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ title, context: context || null, dueAt: new Date(dueAt), sourceType: "manual", triggerType: "before_due", offsetMinutes, channel, requireApproval: channel === "email" });
        }}>
          <div className="space-y-2"><Label htmlFor="reminder-title">Commitment</Label><Input id="reminder-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What must be followed through?" minLength={3} maxLength={500} required /></div>
          <div className="space-y-2"><Label htmlFor="reminder-context">Context</Label><Textarea id="reminder-context" value={context} onChange={(event) => setContext(event.target.value)} placeholder="Why it matters and what a useful next action looks like" maxLength={10_000} /></div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2"><Label htmlFor="reminder-due">Due</Label><Input id="reminder-due" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} required /></div>
            <div className="space-y-2"><Label htmlFor="reminder-offset">Remind before</Label><Select value={String(offsetMinutes)} onValueChange={(value) => setOffsetMinutes(Number(value))}><SelectTrigger id="reminder-offset"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="0">At due time</SelectItem><SelectItem value="15">15 minutes</SelectItem><SelectItem value="60">1 hour</SelectItem><SelectItem value="1440">1 day</SelectItem><SelectItem value="10080">1 week</SelectItem></SelectContent></Select></div>
            <div className="space-y-2"><Label htmlFor="reminder-channel">Delivery</Label><Select value={channel} onValueChange={(value) => setChannel(value as "in_app" | "email")}><SelectTrigger id="reminder-channel"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="in_app">In dashboard</SelectItem><SelectItem value="email">Email draft</SelectItem></SelectContent></Select></div>
          </div>
          {channel === "email" && <Alert><Mail className="size-4" /><AlertTitle>Email stays approval-gated</AlertTitle><AlertDescription>The system prepares the message when due. Nothing leaves the dashboard until you approve it.</AlertDescription></Alert>}
          <div className="flex justify-end"><Button type="submit" disabled={create.isPending || title.trim().length < 3}>{create.isPending && <Loader2 className="size-4 animate-spin" />}Schedule commitment</Button></div>
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ReminderQueueRow({ row, onSelect }: { row: ReminderRow; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className="grid w-full gap-2 px-4 py-3 text-left hover:bg-accent/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <span className="min-w-0"><span className="block truncate font-medium">{row.commitment.title}</span><span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{new Date(row.schedule.scheduledFor).toLocaleString()}</span><span>{row.schedule.channel === "email" ? "Email" : "Dashboard"}</span><span>{row.commitment.sourceType.replaceAll("_", " ")}</span></span></span>
      <Badge variant="outline" className={stateTone(row.schedule.state)}>{stateLabel(row.schedule.state)}</Badge>
    </button>
  );
}

function ReminderReviewSheet({ row, onClose, onChanged }: { row: ReminderRow | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const approve = trpc.reminders.approveAndSend.useMutation({ onSuccess: async () => { toast.success("Reminder sent and recorded"); await onChanged(); }, onError: (error) => toast.error(error.message) });
  const confirmRetry = trpc.reminders.confirmRetry.useMutation({ onSuccess: async () => { toast.success("Delivery check recorded; retry now requires a new approval"); await onChanged(); }, onError: (error) => toast.error(error.message) });
  const close = trpc.reminders.closeCommitment.useMutation({ onSuccess: async () => { toast.success("Commitment updated"); await onChanged(); }, onError: (error) => toast.error(error.message) });
  const [retryConfirmation, setRetryConfirmation] = useState("");
  if (!row) return null;
  const canSend = ["draft_ready", "failed"].includes(row.schedule.state);
  const needsDeliveryReview = row.schedule.state === "needs_review";
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader><SheetTitle>{row.commitment.title}</SheetTitle><SheetDescription>Review the reminder before taking action.</SheetDescription></SheetHeader>
        <div className="mt-6 space-y-5">
          <div className="grid grid-cols-2 gap-3 text-sm"><ReviewFact label="Status" value={stateLabel(row.schedule.state)} /><ReviewFact label="Channel" value={row.schedule.channel === "email" ? "Email" : "Dashboard"} /><ReviewFact label="Due" value={new Date(row.commitment.dueAt).toLocaleString()} /><ReviewFact label="Scheduled" value={new Date(row.schedule.scheduledFor).toLocaleString()} /></div>
          {row.schedule.policyReason && <Alert><ShieldCheck className="size-4" /><AlertTitle>Delivery restriction</AlertTitle><AlertDescription>{row.schedule.policyReason}</AlertDescription></Alert>}
          <section className="space-y-2"><h3 className="text-sm font-semibold">Context</h3><p className="whitespace-pre-wrap text-sm text-muted-foreground">{row.commitment.context || "No extra context was recorded."}</p></section>
          {row.schedule.draftContent && <section className="space-y-2"><h3 className="text-sm font-semibold">Prepared message</h3><div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{row.schedule.draftContent}</div></section>}
          <div className="space-y-2 border-t pt-4">
            {needsDeliveryReview && <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"><Label htmlFor="retry-confirmation">Delivery check required</Label><p className="text-xs text-muted-foreground">Check the destination mailbox or provider activity first. This prevents an uncertain send from being repeated blindly.</p><Textarea id="retry-confirmation" value={retryConfirmation} onChange={(event) => setRetryConfirmation(event.target.value)} placeholder="State where you checked and why a retry is safe." maxLength={2_000} /><Button className="w-full" variant="outline" onClick={() => confirmRetry.mutate({ scheduleId: row.schedule.id, confirmation: retryConfirmation })} disabled={confirmRetry.isPending || retryConfirmation.trim().length < 10}>{confirmRetry.isPending && <Loader2 className="size-4 animate-spin" />}Confirm delivery checked</Button></div>}
            {canSend && <Button className="w-full" onClick={() => approve.mutate({ scheduleId: row.schedule.id })} disabled={approve.isPending}>{approve.isPending ? <Loader2 className="size-4 animate-spin" /> : row.schedule.channel === "email" ? <Mail className="size-4" /> : <BellRing className="size-4" />}Approve and send</Button>}
            <div className="grid grid-cols-2 gap-2"><Button variant="outline" onClick={() => close.mutate({ commitmentId: row.commitment.id, status: "completed" })} disabled={close.isPending}><Check className="size-4" />Complete</Button><Button variant="outline" onClick={() => close.mutate({ commitmentId: row.commitment.id, status: "cancelled" })} disabled={close.isPending}><X className="size-4" />Cancel</Button></div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ReminderPolicyPanel({ dashboard, onSaved }: { dashboard: Dashboard | undefined; onSaved: () => Promise<void> }) {
  const policy = dashboard?.policy;
  const [enabled, setEnabled] = useState(true);
  const [inAppEnabled, setInAppEnabled] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [allowWeekends, setAllowWeekends] = useState(false);
  const [maxPerDay, setMaxPerDay] = useState(3);
  const [minIntervalMinutes, setMinIntervalMinutes] = useState(60);
  const [quietHoursStart, setQuietHoursStart] = useState("22:00");
  const [quietHoursEnd, setQuietHoursEnd] = useState("08:00");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  useEffect(() => {
    if (!policy) return;
    setEnabled(policy.enabled); setInAppEnabled(policy.inAppEnabled); setEmailEnabled(policy.emailEnabled); setAllowWeekends(policy.allowWeekends);
    setMaxPerDay(policy.maxPerDay); setMinIntervalMinutes(policy.minIntervalMinutes); setQuietHoursStart(policy.quietHoursStart); setQuietHoursEnd(policy.quietHoursEnd); setTimezone(policy.timezone);
  }, [policy]);
  const save = trpc.reminders.updatePolicy.useMutation({ onSuccess: async () => { toast.success("Reminder preferences saved"); await onSaved(); }, onError: (error) => toast.error(error.message) });
  return (
    <Card className="gap-0 rounded-lg py-0">
      <CardHeader className="border-b py-4"><CardTitle className="flex items-center gap-2 text-sm"><CalendarClock className="size-4 text-blue-500" />Reminder preferences</CardTitle><CardDescription></CardDescription></CardHeader>
      <CardContent className="space-y-4 p-4">
        <PolicySwitch label="Reminders enabled" checked={enabled} onCheckedChange={setEnabled} />
        <PolicySwitch label="Dashboard delivery" checked={inAppEnabled} onCheckedChange={setInAppEnabled} />
        <PolicySwitch label="Email delivery" checked={emailEnabled} onCheckedChange={setEmailEnabled} />
        <PolicySwitch label="Allow weekends" checked={allowWeekends} onCheckedChange={setAllowWeekends} />
        <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="reminder-limit">Daily limit</Label><Input id="reminder-limit" type="number" min={0} max={50} value={maxPerDay} onChange={(event) => setMaxPerDay(Math.max(0, Math.min(50, Number(event.target.value) || 0)))} /></div><div className="space-y-2"><Label htmlFor="reminder-cooldown">Cooldown (min)</Label><Input id="reminder-cooldown" type="number" min={0} max={10_080} value={minIntervalMinutes} onChange={(event) => setMinIntervalMinutes(Math.max(0, Math.min(10_080, Number(event.target.value) || 0)))} /></div></div>
        <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="quiet-start">Quiet from</Label><Input id="quiet-start" type="time" value={quietHoursStart} onChange={(event) => setQuietHoursStart(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="quiet-end">Quiet until</Label><Input id="quiet-end" type="time" value={quietHoursEnd} onChange={(event) => setQuietHoursEnd(event.target.value)} /></div></div>
        <div className="space-y-2"><Label htmlFor="reminder-timezone">Timezone</Label><Input id="reminder-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></div>
        <Button className="w-full" variant="outline" onClick={() => save.mutate({ enabled, inAppEnabled, emailEnabled, maxPerDay, minIntervalMinutes, quietHoursStart, quietHoursEnd, timezone, allowWeekends })} disabled={save.isPending}>{save.isPending && <Loader2 className="size-4 animate-spin" />}Save preferences</Button>
      </CardContent>
    </Card>
  );
}

function PolicySwitch({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <div className="flex items-center justify-between gap-3"><Label className="font-normal">{label}</Label><Switch checked={checked} onCheckedChange={onCheckedChange} /></div>;
}

function PolicyLine({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{value}</dd></div>;
}

function ReviewFact({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-medium">{value}</div></div>;
}
