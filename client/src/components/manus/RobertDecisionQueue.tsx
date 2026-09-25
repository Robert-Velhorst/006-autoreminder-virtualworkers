/**
 * RobertDecisionQueue — shows all APTLSS steps that require Robert's decision,
 * grouped by card, with urgency tier, a direct link to the Trello card,
 * without allowing a worker to close a founder-owned decision.
 */
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { ExternalLink, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

const URGENCY_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  CRITICAL: { bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400", border: "border-red-500/30" },
  HIGH:     { bg: "bg-orange-500/10", text: "text-orange-600 dark:text-orange-400", border: "border-orange-500/30" },
  MEDIUM:   { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400", border: "border-amber-500/30" },
  LOW:      { bg: "bg-slate-500/10", text: "text-slate-500 dark:text-slate-400", border: "border-slate-500/30" },
  BLOCKED:  { bg: "bg-purple-500/10", text: "text-purple-600 dark:text-purple-400", border: "border-purple-500/30" },
};

export default function RobertDecisionQueue() {
  const { data, isLoading } = trpc.aptlss.getDecisionQueue.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  const items = data?.items ?? [];

  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-orange-500/15 flex items-center justify-center flex-shrink-0">
              <AlertCircle className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Robert Decision Queue</h3>
              <p className="text-[10px] text-muted-foreground">Steps awaiting Robert's input before the worker can proceed</p>
            </div>
          </div>
          {items.length > 0 && (
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/30">
              {items.length} pending
            </span>
          )}
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center gap-2 py-4 text-muted-foreground text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading decision queue…
          </div>
        )}

        {/* All clear */}
        {!isLoading && items.length === 0 && (
          <div className="flex items-center gap-2 py-3 text-emerald-600 dark:text-emerald-400 text-xs">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span className="font-medium">No pending decisions — all clear!</span>
          </div>
        )}

        {/* Decision items */}
        {!isLoading && items.length > 0 && (
          <div className="space-y-2">
            {items.map((item) => {
              const style = URGENCY_STYLES[item.tier ?? "MEDIUM"] ?? URGENCY_STYLES.MEDIUM;
              return (
                <div
                  key={`${item.cardId}-${item.stepIndex}`}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg border ${style.bg} ${style.border}`}
                >
                  {/* Urgency chip */}
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 mt-0.5 ${style.bg} ${style.border} ${style.text}`}>
                    {item.tier ?? "MED"}
                  </span>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate">{item.cardName}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{item.stepTitle}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">Awaiting the founder's recorded decision.</p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* Link to card */}
                    <a
                      href={item.cardUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`flex-shrink-0 p-1.5 rounded hover:bg-white/20 transition-colors ${style.text}`}
                      title="Open card in Trello"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
