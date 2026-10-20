import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, CircleHelp, Clock3, Loader2, Play, Save } from "lucide-react";
import { toast } from "sonner";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";

function formatDuration(milliseconds: number | null | undefined) {
  if (milliseconds === null || milliseconds === undefined) return "Learning from the first run";
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatInterval(minutes: number) {
  if (minutes % 10_080 === 0) return `${minutes / 10_080} week${minutes === 10_080 ? "" : "s"}`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} day${minutes === 1_440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

function latestBadge(status: string | undefined) {
  if (status === "success") return <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="mr-1 size-3" />Success</Badge>;
  if (status === "error") return <Badge variant="destructive"><AlertCircle className="mr-1 size-3" />Failed</Badge>;
  if (status === "running") return <Badge variant="secondary"><Loader2 className="mr-1 size-3 animate-spin" />Running</Badge>;
  return <Badge variant="outline">Never run</Badge>;
}

export function MaintenanceCenter() {
  const [clock, setClock] = useState(Date.now());
  const [draftIntervals, setDraftIntervals] = useState<Record<string, string>>({});
  const utils = trpc.useUtils();
  const status = trpc.maintenance.status.useQuery(undefined, {
    refetchInterval: (query) => query.state.data?.some((job) => job.active) ? 1_000 : 15_000,
  });
  const update = trpc.maintenance.update.useMutation({
    onSuccess: async () => {
      toast.success("Maintenance schedule saved");
      await utils.maintenance.status.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const run = trpc.maintenance.run.useMutation({
    onSuccess: async () => {
      toast.success("Maintenance run started");
      await utils.maintenance.status.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const hasActive = status.data?.some((job) => job.active) ?? false;
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  const categories = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof status.data>>();
    for (const job of status.data ?? []) grouped.set(job.category, [...(grouped.get(job.category) ?? []), job]);
    return [...grouped.entries()];
  }, [status.data]);

  if (status.isLoading) {
    return <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />Loading maintenance controls</div>;
  }
  if (status.error) {
    return <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{status.error.message}</div>;
  }

  return (
    <section className="space-y-4" data-settings-section="Maintenance">
      <div className="border-b pb-4">
        <h3 className="text-lg font-semibold">Maintenance</h3>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Background checks and repairs are grouped here. Each run has its own interval, audit history, live progress, and estimated time remaining.</p>
      </div>

      <Accordion type="multiple" defaultValue={categories.map(([category]) => category)} className="rounded-md border px-4">
        {categories.map(([category, jobs]) => (
          <AccordionItem key={category} value={category}>
            <AccordionTrigger className="no-underline hover:no-underline">
              <span className="flex min-w-0 items-center gap-3">
                <span>{category}</span>
                <Badge variant="secondary">{jobs.length}</Badge>
                {jobs.some((job) => job.active) && <span className="text-xs font-normal text-primary">Run active</span>}
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <Accordion type="multiple" className="border-t">
                {jobs.map((job) => {
                  const active = job.active;
                  const progress = active && active.total > 0 ? Math.min(100, Math.round(active.current / active.total * 100)) : 0;
                  const elapsed = active ? Math.max(0, clock - new Date(active.startedAt).getTime()) : 0;
                  const estimate = job.estimatedDurationMs ?? job.defaultEstimateMs;
                  const remaining = active ? Math.max(0, estimate - elapsed) : estimate;
                  const draft = draftIntervals[job.key] ?? String(job.intervalMinutes);
                  const isSaving = update.isPending && update.variables?.jobKey === job.key;
                  const isStarting = run.isPending && run.variables?.jobKey === job.key;
                  return (
                    <AccordionItem key={job.key} value={job.key} className="last:border-b-0">
                      <AccordionTrigger className="no-underline hover:no-underline">
                        <span className="flex min-w-0 flex-1 items-center gap-3 pr-2">
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 font-medium">
                              <span className="truncate">{job.title}</span>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span role="button" tabIndex={0} className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted" onClick={(event) => event.stopPropagation()}>
                                    <CircleHelp className="size-4" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">{job.description}</TooltipContent>
                              </Tooltip>
                            </span>
                            <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">Every {formatInterval(job.intervalMinutes)}{job.nextRunAt ? ` · next ${new Date(job.nextRunAt).toLocaleString()}` : " · disabled"}</span>
                          </span>
                          {active ? <Badge variant="secondary"><Loader2 className="mr-1 size-3 animate-spin" />{progress}%</Badge> : latestBadge(job.latest?.status)}
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="space-y-4">
                        <div className="grid gap-4 border-t pt-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                          <div className="space-y-3">
                            <p className="text-sm leading-6 text-muted-foreground">{job.description}</p>
                            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">Provider impact:</span> {job.externalEffect}
                            </div>
                            {active ? (
                              <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                                <div className="flex items-center justify-between gap-3 text-sm"><span className="truncate">{active.message}</span><span className="shrink-0 font-medium">ETA {formatDuration(remaining)}</span></div>
                                <Progress value={progress} className="h-2" />
                                <div className="flex justify-between text-xs text-muted-foreground"><span>{active.current} of {active.total}</span><span>{formatDuration(elapsed)} elapsed</span></div>
                              </div>
                            ) : job.latest ? (
                              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                                <span><span className="block text-foreground">Last run</span>{new Date(job.latest.startedAt).toLocaleString()}</span>
                                <span><span className="block text-foreground">Duration</span>{formatDuration(job.latest.durationMs)}</span>
                                <span><span className="block text-foreground">Records</span>{job.latest.recordsProcessed}</span>
                                {job.latest.errorMessage && <p className="sm:col-span-3 text-destructive">{job.latest.errorMessage}</p>}
                              </div>
                            ) : <p className="text-xs text-muted-foreground">No run history yet. Initial ETA: {formatDuration(estimate)}.</p>}
                          </div>

                          <div className="space-y-3 rounded-md border p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div><p className="text-sm font-medium">Automatic run</p><p className="text-xs text-muted-foreground">Use this job's interval</p></div>
                              <Switch
                                checked={job.enabled}
                                onCheckedChange={(enabled) => update.mutate({ jobKey: job.key, enabled, intervalMinutes: Number(draft) || job.intervalMinutes })}
                                disabled={isSaving}
                              />
                            </div>
                            <label className="block text-xs font-medium" htmlFor={`interval-${job.key}`}>Interval in minutes</label>
                            <div className="flex gap-2">
                              <Input id={`interval-${job.key}`} type="number" min={job.minimumIntervalMinutes} max={43_200} value={draft} onChange={(event) => setDraftIntervals((current) => ({ ...current, [job.key]: event.target.value }))} />
                              <Button size="icon" variant="outline" title="Save interval" onClick={() => update.mutate({ jobKey: job.key, enabled: job.enabled, intervalMinutes: Number(draft) || job.intervalMinutes })} disabled={isSaving}>
                                {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                              </Button>
                            </div>
                            <Button className="w-full" variant="outline" onClick={() => run.mutate({ jobKey: job.key })} disabled={Boolean(active) || isStarting}>
                              {active || isStarting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
                              {active ? `Running · ETA ${formatDuration(remaining)}` : "Run now"}
                            </Button>
                            <p className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3" />Expected {formatDuration(job.estimatedDurationMs ?? job.defaultEstimateMs)}</p>
                          </div>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
