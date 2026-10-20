import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Bot,
  User,
  MessageSquare,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  RefreshCw,
  Search,
  ExternalLink,
  ChevronRight,
  History,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { ConversationThread } from './ConversationThread';

interface Conversation {
  id: number;
  cardTrelloId: string;
  cardName: string;
  boardTrelloId: string;
  command: string;
  commandArgs: string[];
  authorTrelloId: string;
  authorName: string;
  responseStatus: 'pending' | 'success' | 'failed';
  responseTimeMs: number | null;
  receivedAt: string;
  respondedAt: string | null;
}

interface CardGroup {
  cardId: string;
  cardName: string;
  conversations: Conversation[];
  lastActivity: string;
}

export function ConversationBrowser() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [commandFilter, setCommandFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const loadRecentConversations = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/trello-webhook/recent?days=7', {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to load conversation history');
      const data = await response.json();
      const recent = Array.isArray(data.conversations) ? data.conversations : [];
      setConversations(recent.map((conversation: any): Conversation => ({
        ...conversation,
        cardName: conversation.cardName || conversation.cardTrelloId,
        boardTrelloId: conversation.boardTrelloId || '',
        commandArgs: Array.isArray(conversation.commandArgs)
          ? conversation.commandArgs
          : (() => {
              try { return JSON.parse(conversation.commandArgs || '[]'); }
              catch { return []; }
            })(),
        authorTrelloId: conversation.authorTrelloId || '',
        authorName: conversation.authorName || 'Unknown user',
        responseStatus: conversation.responseStatus === 'failed' ? 'failed' : conversation.responseStatus,
      })));
    } catch (error) {
      console.error('Error loading conversations:', error);
      setConversations([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRecentConversations();
  }, []);

  // Group conversations by card
  const groupedConversations: CardGroup[] = conversations.reduce((groups, conv) => {
    const existing = groups.find(g => g.cardId === conv.cardTrelloId);
    if (existing) {
      existing.conversations.push(conv);
      if (new Date(conv.receivedAt) > new Date(existing.lastActivity)) {
        existing.lastActivity = conv.receivedAt;
      }
    } else {
      groups.push({
        cardId: conv.cardTrelloId,
        cardName: conv.cardName || conv.cardTrelloId,
        conversations: [conv],
        lastActivity: conv.receivedAt,
      });
    }
    return groups;
  }, [] as CardGroup[]);

  // Sort by last activity
  groupedConversations.sort((a, b) => 
    new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );

  // Filter
  const filteredGroups = groupedConversations.filter(group => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (!group.cardName.toLowerCase().includes(query) &&
          !group.conversations.some(c => 
            c.authorName?.toLowerCase().includes(query) ||
            c.command.toLowerCase().includes(query)
          )) {
        return false;
      }
    }
    
    if (commandFilter !== 'all') {
      if (!group.conversations.some(c => c.command === commandFilter)) {
        return false;
      }
    }
    
    if (statusFilter !== 'all') {
      if (!group.conversations.some(c => c.responseStatus === statusFilter)) {
        return false;
      }
    }
    
    return true;
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="h-3 w-3 text-green-500" />;
      case 'failed':
        return <XCircle className="h-3 w-3 text-red-500" />;
      case 'pending':
        return <AlertCircle className="h-3 w-3 text-yellow-500" />;
      default:
        return null;
    }
  };

  // Get unique commands for filter
  const uniqueCommands = Array.from(new Set(conversations.map(c => c.command)));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" />
            Conversation History
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={loadRecentConversations} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <div className="flex gap-3 mb-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search cards, users, or commands..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={commandFilter} onValueChange={setCommandFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Command" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Commands</SelectItem>
              <SelectItem value="status">status</SelectItem>
              <SelectItem value="checkin">checkin</SelectItem>
              <SelectItem value="time">time</SelectItem>
              <SelectItem value="progress">progress</SelectItem>
              <SelectItem value="remind">remind</SelectItem>
              <SelectItem value="help">help</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Conversation List */}
        <ScrollArea className="h-[400px]">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="p-3 border rounded-lg">
                  <Skeleton className="h-4 w-48 mb-2" />
                  <Skeleton className="h-3 w-32" />
                </div>
              ))}
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
              <MessageSquare className="h-12 w-12 mb-4 opacity-50" />
              <p className="text-sm">No conversations found</p>
              <p className="text-xs mt-1">
                {searchQuery || commandFilter !== 'all' || statusFilter !== 'all'
                  ? 'Try adjusting your filters'
                  : 'Conversations will appear here after @bot interactions'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredGroups.map((group) => (
                <ConversationThread
                  key={group.cardId}
                  cardId={group.cardId}
                  cardName={group.cardName}
                  trigger={
                    <div className="w-full p-3 border rounded-lg hover:bg-muted/50 cursor-pointer transition-colors text-left">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Bot className="h-4 w-4 text-primary" />
                          <span className="font-medium text-sm truncate max-w-[300px]">
                            {group.cardName}
                          </span>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <MessageSquare className="h-3 w-3" />
                          {group.conversations.length} message{group.conversations.length !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(group.lastActivity), { addSuffix: true })}
                        </span>
                        {/* Show last command badges */}
                        <div className="flex gap-1">
                          {Array.from(new Set(group.conversations.slice(0, 3).map(c => c.command))).map(cmd => (
                            <Badge key={cmd} variant="secondary" className="text-xs py-0">
                              {cmd}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Quick Card Lookup */}
        <div className="mt-4 pt-4 border-t">
          <CardLookup />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Quick card lookup component
 */
function CardLookup() {
  const [cardId, setCardId] = useState('');
  
  return (
    <div className="flex gap-2">
      <Input
        placeholder="Enter Trello card ID to view conversations..."
        value={cardId}
        onChange={(e) => setCardId(e.target.value)}
        className="flex-1"
      />
      <ConversationThread
        cardId={cardId}
        trigger={
          <Button disabled={!cardId}>
            <MessageSquare className="h-4 w-4 mr-2" />
            View
          </Button>
        }
      />
    </div>
  );
}

export default ConversationBrowser;
