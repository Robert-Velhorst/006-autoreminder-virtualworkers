import { trpc } from "@/lib/trpc";
import {
  isManagerPilotDenied,
  managerStatusQueryOptions,
} from "@/lib/managerPilotAvailability";
import { Badge } from "@/components/ui/badge";

export default function ManagerShadowSettings() {
  const manager = trpc.operator.getManagerStatus.useQuery(
    undefined,
    managerStatusQueryOptions
  );
  if (isManagerPilotDenied(manager.error))
    return (
      <p role="status" className="border-y py-4 text-sm text-muted-foreground">
        APTLSS manager is unavailable for this worker.
      </p>
    );
  const policy = manager.data?.policy;
  const schedulerState = manager.error ? undefined : manager.data?.scheduler?.state;
  const schedulerMessage = policy?.enabled === false && !manager.error
    ? "Automatic checks for your work are paused."
    : schedulerState === "responding"
      ? "Automatic checks on this server are responding."
      : schedulerState === "stopped"
        ? "Automatic checks are not running on this server. Contact your supervisor."
        : schedulerState === "checking"
          ? "Automatic checks are starting or awaiting confirmation."
          : schedulerState === "unavailable"
            ? "Automatic checks need attention. Contact your supervisor."
            : "Automatic-check status is unavailable. Contact your supervisor if this continues.";
  return (
    <section
      className="min-w-0 space-y-4 border-y py-4"
      aria-label="Manager schedule"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Work guidance</h2>
        <Badge variant="outline">
          {policy?.mode === "shadow"
            ? "Suggestions only"
            : "Status unavailable"}
        </Badge>
      </div>
      {manager.error && (
        <p role="alert" className="text-sm text-destructive">
          Work-guidance settings could not be loaded. Try again or contact your
          supervisor.
        </p>
      )}
      {policy && (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p role="status">{schedulerMessage}</p>
          <p>Configured check interval: {policy.intervalMinutes} minutes.</p>
          <p>Schedule changes are managed by your founder or admin.</p>
        </div>
      )}
    </section>
  );
}
