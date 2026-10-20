import { useState, useEffect, useRef } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CheckCircle, XCircle, Loader2, AlertTriangle, Brain, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CardResult {
  cardId: number;
  cardName?: string;
  success: boolean;
  error?: string;
}

interface Board {
  id: number;
  name: string;
  cardCount: number;
}

interface ReanalysisProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedBoardId?: string;
  preselectedBoardName?: string;
  cardIds?: number[];
  onComplete?: (results: { total: number; processed: number; failed: number }) => void;
}

export function ReanalysisProgressModal({
  open,
  onOpenChange,
  preselectedBoardId,
  preselectedBoardName,
  cardIds,
  onComplete,
}: ReanalysisProgressModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ total: 0, processed: 0, failed: 0 });
  const [results, setResults] = useState<CardResult[]>([]);
  const [currentCard, setCurrentCard] = useState<string>('');
  const [isComplete, setIsComplete] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Board selection state
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string>('all');
  const [loadingBoards, setLoadingBoards] = useState(false);

  // Fetch boards when modal opens
  useEffect(() => {
    if (open && !preselectedBoardId && !cardIds) {
      fetchBoards();
    }
  }, [open, preselectedBoardId, cardIds]);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setIsProcessing(false);
      setProgress({ total: 0, processed: 0, failed: 0 });
      setResults([]);
      setCurrentCard('');
      setIsComplete(false);
      setSelectedBoardId(preselectedBoardId || 'all');
    }
  }, [open, preselectedBoardId]);

  const fetchBoards = async () => {
    setLoadingBoards(true);
    try {
      const response = await fetch('/api/atis/boards', {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        // Get card counts for each board
        const boardsWithCounts = await Promise.all(
          data.map(async (board: any) => {
            try {
              const countRes = await fetch(`/api/atis/cards?boardId=${encodeURIComponent(board.id)}&limit=500`, {
                credentials: 'include',
              });
              const countData = countRes.ok ? await countRes.json() : [];
              return {
                id: board.id,
                name: board.name,
                cardCount: Array.isArray(countData) ? countData.length : 0,
              };
            } catch {
              return {
                id: board.id,
                name: board.name,
                cardCount: 0,
              };
            }
          })
        );
        setBoards(boardsWithCounts.filter(b => b.cardCount > 0));
      }
    } catch (error) {
      console.error('Failed to fetch boards:', error);
    } finally {
      setLoadingBoards(false);
    }
  };

  const startReanalysis = async () => {
    setIsProcessing(true);
    setIsComplete(false);
    setResults([]);
    
    abortControllerRef.current = new AbortController();

    try {
      const body: any = { forceAll: true, limit: 500 };
      
      // Use preselected board or user-selected board
      const boardIdToUse = preselectedBoardId || (selectedBoardId !== 'all' ? selectedBoardId : undefined);
      if (boardIdToUse) {
        body.boardId = boardIdToUse;
      }
      if (cardIds && cardIds.length > 0) {
        body.cardIds = cardIds;
        body.forceAll = false;
      }

      const response = await fetch('/api/atis/understanding/reanalyze-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
        signal: abortControllerRef.current.signal,
      });

      if (response.ok) {
        const data = await response.json();
        setProgress({
          total: data.total,
          processed: data.processed,
          failed: data.failed,
        });
        setResults(data.results || []);
        setIsComplete(true);
        onComplete?.({
          total: data.total,
          processed: data.processed,
          failed: data.failed,
        });
      } else {
        const error = await response.json();
        setResults([{ cardId: 0, success: false, error: error.error || 'Unknown error' }]);
        setIsComplete(true);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        setResults([{ cardId: 0, success: false, error: error.message || 'Failed to start re-analysis' }]);
        setIsComplete(true);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsProcessing(false);
    onOpenChange(false);
  };

  const handleClose = () => {
    if (isProcessing) {
      handleCancel();
    } else {
      onOpenChange(false);
    }
  };

  const progressPercent = progress.total > 0 
    ? Math.round((progress.processed / progress.total) * 100) 
    : 0;

  // Determine title based on selection
  const getTitle = () => {
    if (preselectedBoardName) {
      return `Re-analyze: ${preselectedBoardName}`;
    }
    if (cardIds && cardIds.length > 0) {
      return `Re-analyze ${cardIds.length} Selected Cards`;
    }
    if (selectedBoardId !== 'all') {
      const board = boards.find(b => b.id.toString() === selectedBoardId);
      return board ? `Re-analyze: ${board.name}` : 'Re-analyze Selected Board';
    }
    return 'Re-analyze All Cards';
  };

  const getCardCount = () => {
    if (cardIds && cardIds.length > 0) {
      return cardIds.length;
    }
    if (selectedBoardId !== 'all') {
      const board = boards.find(b => b.id.toString() === selectedBoardId);
      return board?.cardCount || 0;
    }
    return boards.reduce((sum, b) => sum + b.cardCount, 0);
  };

  const showBoardSelector = !preselectedBoardId && !cardIds && !isProcessing && !isComplete;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            {getTitle()}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4 min-w-0 w-full">
          {/* Board Selector */}
          {showBoardSelector && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Layers className="h-4 w-4" />
                Select Board (Optional)
              </Label>
              <Select value={selectedBoardId} onValueChange={setSelectedBoardId}>
                <SelectTrigger>
                  <SelectValue placeholder="All boards" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    All Boards ({boards.reduce((sum, b) => sum + b.cardCount, 0)} cards)
                  </SelectItem>
                  {loadingBoards ? (
                    <SelectItem value="loading" disabled>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Loading boards...
                    </SelectItem>
                  ) : (
                    boards.map(board => (
                      <SelectItem key={board.id} value={board.id.toString()}>
                        {board.name} ({board.cardCount} cards)
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Status */}
          {!isProcessing && !isComplete && (
            <div className="text-center py-4">
              <Brain className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-muted-foreground mb-2">
                This will regenerate AI checklists for <strong>{getCardCount()}</strong> cards using the improved completeness-focused prompt.
              </p>
              <p className="text-sm text-muted-foreground">
                The new checklists will include communication threads, commitments, stakeholders, dependencies, quality gates, and follow-ups.
              </p>
            </div>
          )}

          {/* Progress */}
          {(isProcessing || isComplete) && (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Progress</span>
                  <span className="font-medium">
                    {progress.processed} / {progress.total} cards
                  </span>
                </div>
                <Progress value={progressPercent} className="h-2" />
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 justify-center">
                <div className="flex items-center gap-1 text-sm">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span>{progress.processed - progress.failed} success</span>
                </div>
                <div className="flex items-center gap-1 text-sm">
                  <XCircle className="h-4 w-4 text-red-500" />
                  <span>{progress.failed} failed</span>
                </div>
              </div>

              {/* Current card */}
              {isProcessing && currentCard && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="truncate">Processing: {currentCard}</span>
                </div>
              )}

              {/* Results list */}
              {results.length > 0 && (
                <ScrollArea className="h-[200px] border rounded-lg p-2">
                  <div className="space-y-1">
                    {results.map((result, index) => (
                      <div
                        key={index}
                        className={cn(
                          "flex items-center gap-2 text-sm p-2 rounded min-w-0 w-full",
                          result.success ? "bg-green-50 dark:bg-green-950/20" : "bg-red-50 dark:bg-red-950/20"
                        )}
                      >
                        {result.success ? (
                          <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
                        )}
                        <span className="truncate flex-1">
                          {result.cardName || `Card #${result.cardId}`}
                        </span>
                        {result.error && (
                          <Badge variant="destructive" className="text-xs">
                            {result.error.substring(0, 30)}
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              {/* Completion message */}
              {isComplete && (
                <div className={cn(
                  "p-4 rounded-lg text-center",
                  progress.failed === 0 ? "bg-green-50 dark:bg-green-950/20" : "bg-yellow-50 dark:bg-yellow-950/20"
                )}>
                  {progress.failed === 0 ? (
                    <>
                      <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-500" />
                      <p className="font-medium text-green-700 dark:text-green-400">
                        Re-analysis complete!
                      </p>
                      <p className="text-sm text-green-600 dark:text-green-500">
                        All {progress.processed} cards processed successfully.
                      </p>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-yellow-500" />
                      <p className="font-medium text-yellow-700 dark:text-yellow-400">
                        Re-analysis completed with some errors
                      </p>
                      <p className="text-sm text-yellow-600 dark:text-yellow-500">
                        {progress.processed - progress.failed} succeeded, {progress.failed} failed.
                      </p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          {!isProcessing && !isComplete && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={startReanalysis} disabled={loadingBoards}>
                <Brain className="h-4 w-4 mr-2" />
                Start Re-analysis
              </Button>
            </>
          )}
          {isProcessing && (
            <Button variant="destructive" onClick={handleCancel}>
              Cancel
            </Button>
          )}
          {isComplete && (
            <Button onClick={handleClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
