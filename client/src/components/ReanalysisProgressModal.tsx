import { useEffect, useState } from "react";
import { AtisAnalysisDialog } from "@/components/AtisAnalysisDialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RefreshCw } from "lucide-react";

interface ReanalysisProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedBoardId?: string;
  preselectedBoardName?: string;
  cardIds?: number[];
  onComplete?: (results: { total: number; processed: number; failed: number }) => void;
}
export function ReanalysisProgressModal(props: ReanalysisProgressModalProps) {
  const [boards, setBoards] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedBoard, setSelectedBoard] = useState("all");
  const [reviewing, setReviewing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (!props.open) { setReviewing(false); return; }
    setSelectedBoard(props.preselectedBoardId ?? "all");
    setLoadError(false);
    if (props.preselectedBoardId || props.cardIds) { setReviewing(true); return; }
    const controller = new AbortController();
    void fetch("/api/atis/boards", { credentials: "include", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
      .then(async response => { if (!response.ok) throw new Error(); const rows = await response.json(); if (!Array.isArray(rows)) throw new Error(); if (!controller.signal.aborted) setBoards(rows); })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, [props.open, props.preselectedBoardId, props.cardIds]);
  if (!reviewing) return <Dialog open={props.open} onOpenChange={props.onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>Re-analyze cards</DialogTitle><DialogDescription>Select a board, then review the exact batch before confirming.</DialogDescription></DialogHeader>
    <Label htmlFor="analysis-board">Board</Label>
    <select id="analysis-board" className="border rounded-md p-2" value={selectedBoard} onChange={event => setSelectedBoard(event.target.value)}>
      <option value="all">All boards</option>{boards.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}
    </select>
    {loadError && <p role="alert">Board list unavailable. You can still preview all accessible cards.</p>}
    <Button onClick={() => setReviewing(true)}><RefreshCw className="size-4" />Preview selected cards</Button>
  </DialogContent></Dialog>;
  return <AtisAnalysisDialog open={props.open} onOpenChange={props.onOpenChange}
    title={props.preselectedBoardName ? `Re-analyze: ${props.preselectedBoardName}` : "Re-analyze cards"}
    selection={{ mode: "reanalyze", ...(selectedBoard === "all" && !props.cardIds ? { forceAll: true } : {}), cardIds: props.cardIds,
      ...(selectedBoard === "all" ? {} : { boardId: Number(selectedBoard) }), limit: 100 }}
    onCompleted={job => props.onComplete?.({ total: job.total, processed: job.processed, failed: job.failed })} />;
}
