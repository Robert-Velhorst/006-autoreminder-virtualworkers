import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { isManagerPilotDenied, managerStatusQueryOptions } from "@/lib/managerPilotAvailability";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export default function ManagerShadowSettings() {
  const utils = trpc.useUtils();
  const manager = trpc.operator.getManagerStatus.useQuery(undefined, managerStatusQueryOptions);
  const [enabled, setEnabled] = useState(false);
  const [interval, setInterval] = useState(5);
  useEffect(() => {
    if (!manager.data?.policy) return;
    setEnabled(manager.data.policy.enabled);
    setInterval(manager.data.policy.intervalMinutes);
  }, [manager.data?.policy.enabled, manager.data?.policy.intervalMinutes]);
  const save = trpc.operator.updateManagerPolicy.useMutation({
    onSuccess: () => { void utils.operator.getManagerStatus.invalidate(); toast.success("APTLSS manager schedule saved"); },
    onError: error => toast.error(error.message),
  });
  const unavailable = manager.data?.policy.mode !== "shadow" || !!manager.error || manager.isFetching || save.isPending;
  const valid = Number.isInteger(interval) && interval >= 1 && interval <= 60;
  if (isManagerPilotDenied(manager.error)) return <p role="status" className="border-y py-4 text-sm text-muted-foreground">APTLSS manager is unavailable for this worker.</p>;
  return <section className="min-w-0 space-y-4 border-y py-4" aria-label="Manager schedule">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">Work guidance</h2><Badge variant="outline">{manager.data?.policy.mode === "shadow" ? "Suggestions only" : "Paused"}</Badge></div>
    {manager.error && <p role="alert" className="text-sm text-destructive">{manager.error.message}</p>}
    <form onSubmit={event => { event.preventDefault(); if (!unavailable && valid) save.mutate({ enabled, intervalMinutes: interval }); }}>
      <fieldset disabled={unavailable} className="space-y-4">
        <div className="flex items-center justify-between gap-4"><Label htmlFor="manager-enabled">Continuous guidance</Label><Switch id="manager-enabled" checked={enabled} onCheckedChange={setEnabled} /></div>
        <div className="max-w-xs space-y-1"><Label htmlFor="manager-interval">Assessment interval</Label><div className="flex items-center gap-2"><Input id="manager-interval" type="number" min={1} max={60} step={1} value={Number.isNaN(interval) ? "" : interval} onChange={event => setInterval(event.target.valueAsNumber)} /><span className="text-xs text-muted-foreground">min</span></div></div>
        <Button type="submit" disabled={unavailable || !valid}>{save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}Save manager schedule</Button>
      </fieldset>
    </form>
  </section>;
}
