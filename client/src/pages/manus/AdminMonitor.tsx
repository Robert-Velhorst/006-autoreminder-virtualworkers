/**
 * AdminMonitor — Owner-only system health and automation monitoring page.
 *
 * Shows:
 *   - Sync health: last successful sync, 24h stats, recent sync log
 *   - Webhook status: active/inactive, count
 *   - Automation actions taken (audit log)
 *   - Cards skipped due to low confidence
 *   - Pending approvals (drafts awaiting human sign-off)
 *   - Failed recommendations (low-confidence escalations)
 */
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  Shield,
  Webhook,
  Zap,
  XCircle,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  BarChart2,
  History,
} from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";

// ── Helpers ───────────────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: string | number;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-3 ${color}`}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <p className="text-xl font-bold text-foreground">{value}</p>
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="w-6 h-6 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AdminMonitor() {
  const { loading: authLoading } = useAuth();
  const { data, isLoading, isFetching, refetch, error } = trpc.aptlss.getAdminMonitor.useQuery(undefined, {
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const { data: recentAudit, error: auditError, isLoading: auditLoading, refetch: refetchAudit } = trpc.aptlss.getRecentAuditLog.useQuery(
    { limit: 100 },
    { staleTime: 2 * 60_000 }
  );

  const [showFullSyncLog, setShowFullSyncLog] = useState(false);
  const [showFullAuditLog, setShowFullAuditLog] = useState(false);

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">Loading admin monitor…</p>
        </div>
      </div>
    );
  }
  // Access denied — not the owner
  if (error?.data?.code === 'FORBIDDEN') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4 max-w-sm">
          <Shield className="w-12 h-12 text-muted-foreground mx-auto" />
          <h1 className="text-lg font-semibold text-foreground">Access Restricted</h1>
          <p className="text-sm text-muted-foreground">Admin monitoring is only accessible to the project owner.</p>
          <Link href="/robert">
            <Button variant="outline" size="sm">
              <ArrowLeft className="w-3 h-3 mr-1" /> Back to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  if (!data || error?.data?.code === 'UNAUTHORIZED') {
    const sessionExpired = error?.data?.code === 'UNAUTHORIZED';
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div role="alert" className="text-center space-y-4 max-w-sm">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
          <h1 className="text-lg font-semibold text-foreground">
            {sessionExpired ? "Session expired" : "Admin monitor temporarily unavailable"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {sessionExpired ? "Sign in again to view admin monitoring." : "Monitoring data could not be loaded. No current health result is available."}
          </p>
          {!sessionExpired && (
            <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()}>
              <RefreshCw className={`w-3 h-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Try again
            </Button>
          )}
          <Link href="/robert">
            <Button variant="outline" size="sm">
              <ArrowLeft className="w-3 h-3 mr-1" /> Back to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const syncStats = data?.syncStats;
  const lastSync = data?.lastSync;
  const webhookStatus = data?.webhookStatus;
  const pendingApprovals = data?.pendingApprovals ?? [];
  const cardsSkipped = data?.cardsSkipped ?? [];
  const failedRecs = data?.failedRecs ?? [];
  const recentSyncs = data?.recentSyncs ?? [];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border">
        <div className="container py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Link href="/robert">
                <Button variant="ghost" size="sm" className="h-7 text-xs">
                  <ArrowLeft className="w-3 h-3 mr-1" /> Back
                </Button>
              </Link>
              <Shield className="w-4 h-4 text-muted-foreground" />
              <h1 className="text-sm font-semibold text-foreground">Admin Monitor</h1>
              {isFetching && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
            </div>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { void refetch(); void refetchAudit(); }}>
              <RefreshCw className="w-3 h-3 mr-1" /> Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="container py-6 space-y-6 max-w-4xl">
        {error && (
          <div role="alert" className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <p>Refresh failed. Showing the last successful monitor result; it may be out of date.</p>
          </div>
        )}
        {/* ── Sync Health Stats ─────────────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionTitle icon={<Activity className="w-3.5 h-3.5 text-blue-500" />} title="Sync Health (Last 24h)" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <StatCard
                label="Total Syncs"
                value={syncStats?.totalRuns ?? 0}
                color="bg-blue-500/5 border-blue-500/20"
                icon={<Activity className="w-3.5 h-3.5 text-blue-500" />}
              />
              <StatCard
                label="Successful"
                value={syncStats?.successRuns ?? 0}
                color="bg-green-500/5 border-green-500/20"
                icon={<CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
              />
              <StatCard
                label="Failed"
                value={syncStats?.failedRuns ?? 0}
                color={syncStats?.failedRuns ? "bg-red-500/5 border-red-500/20" : "bg-muted border-border"}
                icon={<XCircle className="w-3.5 h-3.5 text-red-500" />}
              />
              <StatCard
                label="Cards Synced"
                value={syncStats?.totalCardsProcessed ?? 0}
                color="bg-purple-500/5 border-purple-500/20"
                icon={<BarChart2 className="w-3.5 h-3.5 text-purple-500" />}
              />
            </div>
            {/* Last successful sync */}
            {lastSync && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                Last successful sync:{" "}
                <span className="text-foreground font-medium">
                  {new Date(lastSync.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                {lastSync.cardsProcessed != null && (
                  <span>· {lastSync.cardsProcessed} cards</span>
                )}
              </div>
            )}
            {/* Recent sync log */}
            <div>
              <button
                onClick={() => setShowFullSyncLog(o => !o)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <History className="w-3 h-3" />
                Recent sync log ({recentSyncs.length})
                {showFullSyncLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {showFullSyncLog && (
                <div className="mt-2 space-y-1 border-l-2 border-muted pl-3 max-h-48 overflow-y-auto">
                  {recentSyncs.map((s, i) => (
                    <div key={i} className="text-[10px] text-muted-foreground flex items-center gap-2">
                      {s.success ? (
                        <CheckCircle2 className="w-2.5 h-2.5 text-green-500 flex-shrink-0" />
                      ) : (
                        <XCircle className="w-2.5 h-2.5 text-red-500 flex-shrink-0" />
                      )}
                      <span className="text-foreground font-medium">
                        {new Date(s.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span>{s.cardsProcessed ?? 0} cards</span>
                      {s.errorMessage && (
                        <span className="text-red-500 truncate">{s.errorMessage}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Webhook Status ────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionTitle icon={<Webhook className="w-3.5 h-3.5 text-indigo-500" />} title="Webhook Status" />
            {webhookStatus?.state === "active" || webhookStatus?.state === "inactive" ? (
              <div className="flex items-center gap-3 flex-wrap">
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${webhookStatus.active ? "bg-green-500/10 border-green-500/30" : "bg-red-500/10 border-red-500/30"}`}>
                  {webhookStatus.active ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500" />
                  )}
                  <span className={`text-sm font-medium ${webhookStatus.active ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"}`}>
                    {webhookStatus.active ? "Active" : "Inactive"}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">{webhookStatus.count} webhook{webhookStatus.count !== 1 ? 's' : ''} registered</span>
              </div>
            ) : webhookStatus?.state === "unconfigured" ? (
              <p className="text-sm text-muted-foreground">Trello credentials not configured. Webhook health has not been checked.</p>
            ) : (
              <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Webhook status unavailable. Trello could not be checked; activity and registered count are unknown.</p>
            )}
          </CardContent>
        </Card>

        {/* ── Pending Approvals ─────────────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionTitle icon={<Clock className="w-3.5 h-3.5 text-amber-500" />} title={`Pending Approvals (${pendingApprovals.length})`} />
            {pendingApprovals.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                No drafts awaiting approval.
              </div>
            ) : (
              <div className="space-y-2">
                {pendingApprovals.map(entry => (
                  <div key={entry.id} className="flex items-start gap-2 p-2.5 rounded-lg border bg-amber-500/5 border-amber-500/20">
                    <Clock className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground">{entry.cardName}</p>
                      <p className="text-[10px] text-muted-foreground">{entry.action.replace(/_/g, ' ')} — {entry.description}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                      </p>
                    </div>
                    {entry.confidenceScore != null && (
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        {entry.confidenceScore}% conf.
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Cards Skipped (Low Confidence) ───────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionTitle icon={<AlertTriangle className="w-3.5 h-3.5 text-orange-500" />} title={`Cards Skipped — Low Confidence (${cardsSkipped.length})`} />
            {cardsSkipped.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                No cards were skipped due to low confidence in the last 24h.
              </div>
            ) : (
              <div className="space-y-2">
                {cardsSkipped.map(entry => (
                  <div key={entry.id} className="flex items-start gap-2 p-2.5 rounded-lg border bg-orange-500/5 border-orange-500/20">
                    <AlertTriangle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground">{entry.cardName}</p>
                      <p className="text-[10px] text-muted-foreground">{entry.description}</p>
                    </div>
                    {entry.confidenceScore != null && (
                      <span className="text-[10px] text-orange-600 dark:text-orange-400 flex-shrink-0 font-medium">
                        {entry.confidenceScore}% conf.
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Failed Recommendations ────────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <SectionTitle icon={<XCircle className="w-3.5 h-3.5 text-red-500" />} title={`Failed Recommendations (${failedRecs.length})`} />
            {failedRecs.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                No failed recommendations.
              </div>
            ) : (
              <div className="space-y-2">
                {failedRecs.map(entry => (
                  <div key={entry.id} className="flex items-start gap-2 p-2.5 rounded-lg border bg-red-500/5 border-red-500/20">
                    <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground">{entry.cardName}</p>
                      <p className="text-[10px] text-muted-foreground">{entry.description}</p>
                    </div>
                    {entry.confidenceScore != null && (
                      <span className="text-[10px] text-red-600 dark:text-red-400 flex-shrink-0 font-medium">
                        {entry.confidenceScore}% conf.
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Full Automation Audit Log ─────────────────────────────────────── */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <SectionTitle icon={<History className="w-3.5 h-3.5 text-slate-500" />} title="Recent Automation Log" />
              <button
                onClick={() => setShowFullAuditLog(o => !o)}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                {showFullAuditLog ? "Collapse" : "Expand all"}
                {showFullAuditLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>
            {auditError && (
              <p role="alert" className="text-sm text-amber-700 dark:text-amber-300 mb-2">
                {recentAudit ? "Automation log refresh failed. Showing the last successful result; it may be out of date." : "Automation log temporarily unavailable."}
              </p>
            )}
            {auditLoading ? (
              <p className="text-xs text-muted-foreground">Loading automation log...</p>
            ) : !recentAudit ? (
              !auditError && <p className="text-xs text-muted-foreground">Automation log unavailable.</p>
            ) : recentAudit.length === 0 && !auditError ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                No automation actions recorded yet.
              </div>
            ) : (
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {(showFullAuditLog ? recentAudit : recentAudit?.slice(0, 20))?.map(entry => (
                  <div key={entry.id} className="flex items-start gap-2 py-1.5 border-b border-border/40 last:border-0">
                    <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 flex-shrink-0 mt-1.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(entry.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                        <span className="text-[10px] font-medium text-foreground">{entry.action.replace(/_/g, ' ')}</span>
                        <span className="text-[10px] text-blue-600 dark:text-blue-400 truncate">{entry.cardName}</span>
                        {entry.confidenceScore != null && (
                          <span className="text-[10px] text-muted-foreground">{entry.confidenceScore}%</span>
                        )}
                        {entry.approved === true && (
                          <span className="text-[10px] text-green-600 dark:text-green-400">✓ approved</span>
                        )}
                        {entry.requiresApproval && entry.approved == null && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400">⏳ pending</span>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground truncate">{entry.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
