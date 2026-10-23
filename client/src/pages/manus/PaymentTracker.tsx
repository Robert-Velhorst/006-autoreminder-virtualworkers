import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { FinancialFeatureGate } from '@/components/FinancialFeatureGate';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock, DollarSign, Calendar, AlertTriangle, History } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Returns the number of whole calendar days between now and a target date.
 *  Positive = future, 0 = today, negative = overdue.
 */
function calcDaysUntil(dateStr: string | Date | null | undefined): number {
  if (!dateStr) return 0;
  const target = new Date(dateStr);
  const now = new Date();
  target.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/** Returns a live-updating Date that re-renders the component every minute. */
function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function PaymentTracker() {
  return <FinancialFeatureGate><EnabledPaymentTracker /></FinancialFeatureGate>;
}

function EnabledPaymentTracker() {
  const { user } = useAuth();
  const [showHistory, setShowHistory] = useState(false);

  // Live clock — re-renders every minute so the countdown stays accurate
  useNow();

  const utils = trpc.useUtils();

  const { data: currentCycle, isLoading: cycleLoading } = trpc.payment.getCurrentCycle.useQuery();
  const { data: allCycles, isLoading: historyLoading } = trpc.payment.getAllCycles.useQuery();

  const markPaid = trpc.payment.markPaid.useMutation({
    onSuccess: () => {
      utils.payment.getCurrentCycle.invalidate();
      utils.payment.getAllCycles.invalidate();
      toast.success("Payment recorded", { description: "The cycle has been marked as paid and the next cycle has been created." });
    },
    onError: (err) => {
      toast.error("Error", { description: err.message });
    },
  });

  const daysUntil = calcDaysUntil(currentCycle?.cycleEnd);
  const isOverdue = daysUntil < 0;
  const isDueToday = daysUntil === 0;
  const isDueSoon = daysUntil > 0 && daysUntil <= 3;

  const statusColor = isOverdue
    ? "from-red-500 to-red-600"
    : isDueToday
    ? "from-amber-500 to-orange-500"
    : isDueSoon
    ? "from-yellow-500 to-amber-500"
    : "from-indigo-500 to-violet-600";

  const statusBadge = isOverdue
    ? { label: `${Math.abs(daysUntil)}d Overdue`, variant: "destructive" as const }
    : isDueToday
    ? { label: "Due Today", variant: "default" as const }
    : isDueSoon
    ? { label: `Due in ${daysUntil}d`, variant: "default" as const }
    : { label: `${daysUntil} days away`, variant: "secondary" as const };

  const paidCycles = allCycles?.filter(c => c.isPaid) ?? [];

  return (
    <div className="space-y-4">
      {/* Current Cycle Card */}
      <Card className="border-0 shadow-sm overflow-hidden">
        <div className={`bg-gradient-to-r ${statusColor} p-5 text-white`}>
          <div className="flex items-center gap-2.5 mb-3">
            <DollarSign className="w-5 h-5" />
            <h2 className="text-base font-bold">Payment Tracker</h2>
            {currentCycle && (
              <Badge className="bg-white/20 text-white border-0 text-[10px] ml-auto">
                {statusBadge.label}
              </Badge>
            )}
          </div>

          {cycleLoading ? (
            <div className="bg-white/15 rounded-xl p-4 text-center text-sm opacity-80">Loading...</div>
          ) : currentCycle ? (
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4">
              <div className="grid grid-cols-2 gap-4 mb-3">
                <div>
                  <p className="text-[10px] opacity-70 uppercase tracking-wide mb-0.5">Cycle Start</p>
                  <p className="font-bold text-sm">{formatDate(currentCycle.cycleStart)}</p>
                </div>
                <div>
                  <p className="text-[10px] opacity-70 uppercase tracking-wide mb-0.5">Pay Date</p>
                  <p className="font-bold text-sm">{formatDate(currentCycle.cycleEnd)}</p>
                </div>
                <div>
                  <p className="text-[10px] opacity-70 uppercase tracking-wide mb-0.5">Base Amount</p>
                  <p className="font-bold text-sm">${Number(currentCycle.baseAmount).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[10px] opacity-70 uppercase tracking-wide mb-0.5">Status</p>
                  <p className="font-bold text-sm flex items-center gap-1">
                    {isOverdue ? (
                      <><AlertTriangle className="w-3.5 h-3.5" /> Overdue</>
                    ) : isDueToday ? (
                      <><Clock className="w-3.5 h-3.5" /> Due Today</>
                    ) : (
                      <><Clock className="w-3.5 h-3.5" /> {daysUntil}d remaining</>
                    )}
                  </p>
                </div>
              </div>

              {currentCycle.notes && (
                <p className="text-xs opacity-80 bg-white/10 rounded-lg px-3 py-2 mb-3">{currentCycle.notes}</p>
              )}

              {user ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      disabled={markPaid.isPending}
                      className="w-full bg-white text-indigo-700 hover:bg-white/90 font-semibold text-sm h-9 rounded-lg"
                    >
                      <CheckCircle className="w-4 h-4 mr-2" />
                      {markPaid.isPending ? "Recording..." : "Mark as Paid"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Confirm Payment Received</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to mark this payment cycle as paid? This action cannot be undone.
                        {currentCycle.baseAmount && (
                          <span className="block mt-2 font-medium text-foreground">
                            Base amount: ${Number(currentCycle.baseAmount).toFixed(2)}
                          </span>
                        )}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => markPaid.mutate({ cycleId: currentCycle.id })}
                        className="bg-indigo-600 hover:bg-indigo-700"
                      >
                        Yes, Mark as Paid
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <p className="text-xs opacity-70 text-center">Log in to mark payment</p>
              )}
            </div>
          ) : (
            <div className="bg-white/15 rounded-xl p-4 text-center">
              <CheckCircle className="w-8 h-8 mx-auto mb-2 opacity-80" />
              <p className="font-semibold text-sm">All cycles are paid!</p>
              <p className="text-xs opacity-70 mt-1">No pending payment cycle.</p>
            </div>
          )}
        </div>
      </Card>

      {/* Payment History */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-5">
          <button
            onClick={() => setShowHistory(v => !v)}
            className="w-full flex items-center justify-between"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-1 h-6 rounded-full bg-gradient-to-b from-slate-400 to-slate-600"></div>
              <h2 className="text-base font-bold text-foreground">Payment History</h2>
              <Badge variant="secondary" className="text-[10px]">{paidCycles.length} paid</Badge>
            </div>
            <History className="w-4 h-4 text-muted-foreground" />
          </button>

          {showHistory && (
            <div className="mt-4 space-y-2">
              {historyLoading ? (
                <p className="text-sm text-muted-foreground text-center py-4">Loading history...</p>
              ) : paidCycles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No payment history yet.</p>
              ) : (
                [...paidCycles].reverse().map(cycle => (
                  <div key={cycle.id} className="flex items-center justify-between p-3 bg-muted/40 rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                        <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {formatDate(cycle.cycleStart)} – {formatDate(cycle.cycleEnd)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Paid {cycle.paidAt ? formatDate(cycle.paidAt) : "—"}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                        ${Number(cycle.baseAmount).toFixed(2)}
                      </p>
                      <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-300 dark:border-emerald-700">Paid</Badge>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
