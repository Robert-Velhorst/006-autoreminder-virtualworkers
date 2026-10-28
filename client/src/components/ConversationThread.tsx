import { useState, useEffect, useRef } from 'react';
import { trelloCardUrl } from '@shared/trelloIdentifiers';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Bot,
  User,
  MessageSquare,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

interface Conversation {
  id: number;
  cardTrelloId: string;
  cardName: string;
  boardTrelloId: string;
  command: string;
  commandArgs: string[];
  authorTrelloId: string;
  authorName: string;
  incomingCommentId: string;
  responseCommentId: string | null;
  responseText: string | null;
  responseStatus: 'pending' | 'success' | 'error';
  responseTimeMs: number | null;
  receivedAt: string;
  respondedAt: string | null;
  createdAt: string;
}

interface ConversationThreadProps {
  cardId: string;
  cardName?: string;
  trigger?: React.ReactNode;
}

export function ConversationThread({ cardId, cardName, trigger }: ConversationThreadProps) {
  const cardUrl = trelloCardUrl(cardId);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadConversations = async () => {
    if (!cardId) return;
    
    setLoading(true);
    try {
      const response = await fetch(`/api/trello-webhook/history/${cardId}?limit=50`);
      if (response.ok) {
        const data = await response.json();
        setConversations(data.conversations || []);
      }
    } catch (error) {
      console.error('Error loading conversations:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && cardId) {
      loadConversations();
    }
  }, [open, cardId]);

  // Scroll to bottom when conversations load
  useEffect(() => {
    if (scrollRef.current && conversations.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversations]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="h-3 w-3 text-green-500" />;
      case 'error':
        return <XCircle className="h-3 w-3 text-red-500" />;
      case 'pending':
        return <AlertCircle className="h-3 w-3 text-yellow-500" />;
      default:
        return null;
    }
  };

  const formatResponseTime = (ms: number | null) => {
    if (!ms) return null;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const defaultTrigger = (
    <Button variant="outline" size="sm">
      <MessageSquare className="h-4 w-4 mr-2" />
      View Conversations
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || defaultTrigger}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Chatbot Conversations
            {cardName && (
              <span className="text-sm font-normal text-muted-foreground ml-2">
                {cardName}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between mb-4">
          <Badge variant="secondary">
            {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
          </Badge>
          <Button variant="ghost" size="sm" onClick={loadConversations} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <ScrollArea className="h-[500px] pr-4" ref={scrollRef}>
          {loading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <MessageSquare className="h-12 w-12 mb-4 opacity-50" />
              <p className="text-sm">No conversations yet</p>
              <p className="text-xs mt-1">
                Use @bot commands in Trello to start a conversation
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {conversations.map((conv) => (
                <div key={conv.id} className="space-y-3">
                  {/* User message */}
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                      <User className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">
                          {conv.authorName || 'Unknown User'}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(conv.receivedAt), { addSuffix: true })}
                        </span>
                      </div>
                      <div className="p-3 bg-blue-50 dark:bg-blue-950 rounded-lg rounded-tl-none">
                        <code className="text-sm">
                          @bot {conv.command}
                          {conv.commandArgs?.length > 0 && ` ${conv.commandArgs.join(' ')}`}
                        </code>
                      </div>
                    </div>
                  </div>

                  {/* Bot response */}
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">Bot</span>
                        {getStatusIcon(conv.responseStatus)}
                        {conv.responseTimeMs && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatResponseTime(conv.responseTimeMs)}
                          </span>
                        )}
                        {conv.respondedAt && (
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(conv.respondedAt), { addSuffix: true })}
                          </span>
                        )}
                      </div>
                      <div className="p-3 bg-muted rounded-lg rounded-tl-none">
                        {conv.responseStatus === 'pending' ? (
                          <span className="text-sm text-muted-foreground italic">
                            Waiting for response...
                          </span>
                        ) : conv.responseStatus === 'error' ? (
                          <span className="text-sm text-red-500">
                            Failed to respond
                          </span>
                        ) : (
                          <pre className="text-sm whitespace-pre-wrap font-sans">
                            {conv.responseText || 'No response recorded'}
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="border-b border-border/50 my-4" />
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer with card link */}
        {cardUrl && (
          <div className="pt-4 border-t flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Card ID: {cardId.substring(0, 8)}...
            </span>
            <a
              href={cardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              Open in Trello
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline conversation preview for card lists
 */
export function ConversationPreview({ cardId, cardName }: { cardId: string; cardName?: string }) {
  const [lastConversation, setLastConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadLast = async () => {
      try {
        const response = await fetch(`/api/trello-webhook/history/${cardId}?limit=1`);
        if (response.ok) {
          const data = await response.json();
          if (data.conversations?.length > 0) {
            setLastConversation(data.conversations[0]);
          }
        }
      } catch (error) {
        console.error('Error loading last conversation:', error);
      } finally {
        setLoading(false);
      }
    };

    loadLast();
  }, [cardId]);

  if (loading) {
    return <Skeleton className="h-4 w-20" />;
  }

  if (!lastConversation) {
    return null;
  }

  return (
    <ConversationThread
      cardId={cardId}
      cardName={cardName}
      trigger={
        <Button variant="ghost" size="sm" className="h-auto py-1 px-2">
          <MessageSquare className="h-3 w-3 mr-1" />
          <span className="text-xs">
            Last: @bot {lastConversation.command}
          </span>
        </Button>
      }
    />
  );
}

export default ConversationThread;
