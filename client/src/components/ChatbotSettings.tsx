import { useState, useEffect } from 'react';
import { ConversationBrowser } from './ConversationBrowser';
import { ComplianceDashboard } from './ComplianceDashboard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { 
  Bot, 
  Webhook, 
  Plus, 
  Trash2, 
  RefreshCw, 
  Send, 
  MessageSquare,
  CheckCircle,
  XCircle,
  Loader2,
  Copy,
  ExternalLink,
  Zap,
  BarChart3,
  Users,
  Clock,
  TrendingUp,
  AlertCircle
} from 'lucide-react';

interface Webhook {
  id: string;
  description: string;
  idModel: string;
  callbackURL: string;
  active: boolean;
}

interface AnalyticsStats {
  totalConversations: number;
  totalCommands: Record<string, number>;
  avgResponseTimeMs: number;
  totalCheckins: number;
  totalResponses: number;
  overallResponseRate: number;
  avgCheckinResponseMinutes: number;
  activeWorkers: number;
  activeCards: number;
  topCommands: Array<{ command: string; count: number }>;
}

interface WorkerEngagement {
  workerId: number;
  workerName: string;
  totalCheckins: number;
  responded: number;
  responseRate: number;
  avgResponseMinutes: number;
  lastActivity: string | null;
}

export function ChatbotSettings() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [testing, setTesting] = useState(false);
  
  // Form state for registering new webhook
  const [modelId, setModelId] = useState('');
  const [description, setDescription] = useState('');
  
  // Test form state
  const [testCardId, setTestCardId] = useState('');
  const [testComment, setTestComment] = useState('@bot status');
  const [testResult, setTestResult] = useState<any>(null);
  
  // Analytics state
  const [analytics, setAnalytics] = useState<AnalyticsStats | null>(null);
  const [engagement, setEngagement] = useState<WorkerEngagement[]>([]);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [syncing, setSyncing] = useState(false);
  
  // Webhook status state
  const [webhookStatus, setWebhookStatus] = useState<{
    callbackUrl: string | null;
    publicUrl: string | null;
    isConfigured: boolean;
    isReachable: boolean;
    recommendation: string;
  } | null>(null);

  // Get the callback URL for webhooks
  const callbackUrl = typeof window !== 'undefined' 
    ? `${window.location.origin}/api/trello-webhook`
    : '';

  const loadWebhookStatus = async () => {
    try {
      const response = await fetch('/api/trello-webhook/status');
      if (response.ok) {
        const data = await response.json();
        setWebhookStatus(data.status);
      }
    } catch (error) {
      console.error('Error loading webhook status:', error);
    }
  };

  const loadWebhooks = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/trello-webhook/list');
      if (response.ok) {
        const data = await response.json();
        setWebhooks(data.webhooks || []);
      } else {
        toast.error('Failed to load webhooks');
      }
    } catch (error) {
      console.error('Error loading webhooks:', error);
      toast.error('Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  };

  const registerWebhook = async () => {
    if (!modelId) {
      toast.error('Please enter a Model ID (board or workspace ID)');
      return;
    }

    // Extract board ID from Trello URL if full URL is provided
    let boardId = modelId.trim();
    if (boardId.includes('trello.com')) {
      // Extract ID from URL like https://trello.com/b/ckEuBpNz/board-name
      const match = boardId.match(/\/b\/([a-zA-Z0-9]+)/);
      if (match && match[1]) {
        boardId = match[1];
      } else {
        toast.error('Invalid Trello URL. Please use format: https://trello.com/b/BOARD_ID/board-name');
        return;
      }
    }

    // Validate board ID format (Trello IDs are typically 24 characters or similar)
    if (boardId.length < 8 || boardId.length > 32) {
      toast.error('Invalid board ID. Trello board IDs are typically 24-32 characters long.');
      return;
    }

    // Check if board ID contains only valid characters
    if (!/^[a-zA-Z0-9]+$/.test(boardId)) {
      toast.error('Invalid board ID. Board IDs can only contain letters and numbers.');
      return;
    }

    setRegistering(true);
    try {
      const response = await fetch('/api/trello-webhook/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: boardId,
          description: description || 'VA Dashboard Chatbot',
          callbackUrl,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        toast.success('Webhook registered successfully!');
        setModelId('');
        setDescription('');
        loadWebhooks();
      } else {
        const error = await response.json();
        toast.error(error.error || error.details || 'Failed to register webhook');
      }
    } catch (error) {
      console.error('Error registering webhook:', error);
      toast.error('Failed to register webhook');
    } finally {
      setRegistering(false);
    }
  };

  const deleteWebhook = async (webhookId: string) => {
    try {
      const response = await fetch(`/api/trello-webhook/${webhookId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        toast.success('Webhook deleted');
        loadWebhooks();
      } else {
        toast.error('Failed to delete webhook');
      }
    } catch (error) {
      console.error('Error deleting webhook:', error);
      toast.error('Failed to delete webhook');
    }
  };

  const testChatbot = async () => {
    if (!testCardId || !testComment) {
      toast.error('Please enter a card ID and comment');
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch('/api/trello-webhook/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: testCardId,
          comment: testComment,
          authorName: 'Test User',
        }),
      });

      const data = await response.json();
      setTestResult(data);
      
      if (data.success) {
        toast.success('Command processed successfully!');
      } else {
        toast.info(data.message || 'No command found');
      }
    } catch (error) {
      console.error('Error testing chatbot:', error);
      toast.error('Failed to test chatbot');
    } finally {
      setTesting(false);
    }
  };

  const copyCallbackUrl = () => {
    navigator.clipboard.writeText(callbackUrl);
    toast.success('Callback URL copied to clipboard');
  };

  const loadAnalytics = async () => {
    setLoadingAnalytics(true);
    try {
      const response = await fetch('/api/trello-webhook/analytics?days=30');
      if (response.ok) {
        const data = await response.json();
        setAnalytics(data.stats);
        setEngagement(data.engagement || []);
      }
    } catch (error) {
      console.error('Error loading analytics:', error);
    } finally {
      setLoadingAnalytics(false);
    }
  };

  const syncAllWebhooks = async () => {
    setSyncing(true);
    try {
      const response = await fetch('/api/trello-webhook/sync', {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json();
        toast.success(
          `Sync complete: ${data.registered} registered, ${data.removed} removed`
        );
        loadWebhooks();
      } else {
        toast.error('Failed to sync webhooks');
      }
    } catch (error) {
      console.error('Error syncing webhooks:', error);
      toast.error('Failed to sync webhooks');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    loadWebhooks();
    loadAnalytics();
    loadWebhookStatus();
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Bot className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-semibold">Trello Chatbot</h2>
          <p className="text-sm text-muted-foreground">
            Project manager bot that responds to @bot commands in Trello comments
          </p>
        </div>
      </div>

      {/* Webhook Status */}
      {webhookStatus && (
        <Card className={webhookStatus.isReachable ? 'border-green-500/30' : 'border-yellow-500/30'}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Webhook Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {webhookStatus.isReachable ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-yellow-500" />
                )}
                <span className="text-sm">
                  {webhookStatus.isReachable ? 'Webhooks are configured and reachable' : 'Webhooks may not be reachable'}
                </span>
              </div>
              
              <div className="p-3 bg-muted/50 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Callback URL:</span>
                  <code className="text-xs font-mono truncate max-w-[300px]">
                    {webhookStatus.callbackUrl || 'Not set'}
                  </code>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">PUBLIC_URL:</span>
                  <code className="text-xs font-mono">
                    {webhookStatus.publicUrl || 'Not set'}
                  </code>
                </div>
              </div>
              
              <p className="text-xs text-muted-foreground">
                {webhookStatus.recommendation}
              </p>

              {/* Setup Instructions */}
              {!webhookStatus.isReachable && (
                <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg space-y-3">
                  <h4 className="font-medium text-sm text-yellow-800 flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    Setup Required
                  </h4>
                  <div className="space-y-2 text-sm text-yellow-700">
                    <p>
                      <strong>Step 1:</strong> Publish your app using the Publish button in the top right.
                    </p>
                    <p>
                      <strong>Step 2:</strong> After publishing, set the PUBLIC_URL environment variable in Settings → Secrets:
                    </p>
                    <div className="bg-white/50 p-2 rounded font-mono text-xs break-all">
                      PUBLIC_URL=https://your-app.manus.space
                    </div>
                    <p>
                      <strong>Step 3:</strong> Click "Sync All Boards" below to register webhooks with Trello.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Available Commands */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Available Commands
          </CardTitle>
          <CardDescription>
            Use these commands in Trello card comments to interact with the bot
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="p-3 bg-muted/50 rounded-lg">
              <code className="text-sm font-mono text-primary">@bot status</code>
              <p className="text-xs text-muted-foreground mt-1">
                Show task progress, time tracked, and remaining steps
              </p>
            </div>
            <div className="p-3 bg-muted/50 rounded-lg">
              <code className="text-sm font-mono text-primary">@bot checkin</code>
              <p className="text-xs text-muted-foreground mt-1">
                Request a progress update from the worker
              </p>
            </div>
            <div className="p-3 bg-muted/50 rounded-lg">
              <code className="text-sm font-mono text-primary">@bot remind @worker [message]</code>
              <p className="text-xs text-muted-foreground mt-1">
                Send a reminder to a specific worker
              </p>
            </div>
            <div className="p-3 bg-muted/50 rounded-lg">
              <code className="text-sm font-mono text-primary">@bot time</code>
              <p className="text-xs text-muted-foreground mt-1">
                Show time tracking summary for the card
              </p>
            </div>
            <div className="p-3 bg-muted/50 rounded-lg">
              <code className="text-sm font-mono text-primary">@bot progress</code>
              <p className="text-xs text-muted-foreground mt-1">
                Show detailed progress with full checklist
              </p>
            </div>
            <div className="p-3 bg-muted/50 rounded-lg">
              <code className="text-sm font-mono text-primary">@bot help</code>
              <p className="text-xs text-muted-foreground mt-1">
                Show all available commands
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Webhook Registration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Webhook className="h-4 w-4" />
            Webhook Configuration
          </CardTitle>
          <CardDescription>
            Register webhooks to enable the bot to respond to Trello comments
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Callback URL */}
          <div className="space-y-2">
            <Label>Callback URL</Label>
            <div className="flex gap-2">
              <Input 
                value={callbackUrl} 
                readOnly 
                className="font-mono text-sm bg-muted"
              />
              <Button variant="outline" size="icon" onClick={copyCallbackUrl}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This URL receives webhook events from Trello
            </p>
          </div>

          {/* Auto-Sync All Boards */}
          <div className="space-y-3 pt-4 border-t">
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-Sync Webhooks</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Automatically register webhooks for all boards in ATIS
                </p>
              </div>
              <Button onClick={syncAllWebhooks} disabled={syncing} variant="secondary">
                {syncing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 mr-2" />
                )}
                Sync All Boards
              </Button>
            </div>
          </div>

          {/* Register New Webhook */}
          <div className="space-y-3 pt-4 border-t">
            <Label>Register New Webhook (Manual)</Label>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Model ID (Board or Workspace)</Label>
                <Input
                  placeholder="e.g., 5f1a2b3c4d5e6f7g8h9i0j"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Description (optional)</Label>
                <Input
                  placeholder="e.g., My Project Board"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
            <Button onClick={registerWebhook} disabled={registering || !modelId}>
              {registering ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Register Webhook
            </Button>
          </div>

          {/* Existing Webhooks */}
          <div className="space-y-3 pt-4 border-t">
            <div className="flex items-center justify-between">
              <Label>Registered Webhooks</Label>
              <Button variant="ghost" size="sm" onClick={loadWebhooks} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
            
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : webhooks.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Webhook className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No webhooks registered</p>
                <p className="text-xs">Register a webhook to enable the chatbot</p>
              </div>
            ) : (
              <div className="space-y-2">
                {webhooks.map((webhook) => (
                  <div 
                    key={webhook.id} 
                    className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      {webhook.active ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                      <div>
                        <p className="text-sm font-medium">
                          {webhook.description || 'Unnamed Webhook'}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {webhook.idModel}
                        </p>
                      </div>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={() => deleteWebhook(webhook.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Test Chatbot */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="h-4 w-4" />
            Test Chatbot
          </CardTitle>
          <CardDescription>
            Test bot commands without posting to Trello
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Card ID (Trello)</Label>
              <Input
                placeholder="e.g., 5f1a2b3c4d5e6f7g8h9i0j"
                value={testCardId}
                onChange={(e) => setTestCardId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Comment</Label>
              <Input
                placeholder="@bot status"
                value={testComment}
                onChange={(e) => setTestComment(e.target.value)}
              />
            </div>
          </div>
          
          <Button onClick={testChatbot} disabled={testing || !testCardId}>
            {testing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Test Command
          </Button>

          {testResult && (
            <div className="mt-4 p-4 bg-muted rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                {testResult.success ? (
                  <Badge variant="default" className="bg-green-500">Success</Badge>
                ) : (
                  <Badge variant="secondary">No Command</Badge>
                )}
                {testResult.command && (
                  <Badge variant="outline">{testResult.command}</Badge>
                )}
              </div>
              {testResult.response && (
                <div className="mt-3">
                  <Label className="text-xs text-muted-foreground">Bot Response:</Label>
                  <pre className="mt-1 p-3 bg-background rounded text-sm whitespace-pre-wrap">
                    {testResult.response}
                  </pre>
                </div>
              )}
              {testResult.message && !testResult.success && (
                <p className="text-sm text-muted-foreground">{testResult.message}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Conversation History Browser */}
      <ConversationBrowser />

      {/* Analytics */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Chatbot Analytics (Last 30 Days)
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={loadAnalytics} disabled={loadingAnalytics}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loadingAnalytics ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingAnalytics ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : analytics ? (
            <div className="space-y-6">
              {/* Stats Grid */}
              <div className="grid gap-4 md:grid-cols-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <MessageSquare className="h-4 w-4" />
                    <span className="text-xs">Total Commands</span>
                  </div>
                  <p className="text-2xl font-bold">{analytics.totalConversations}</p>
                </div>
                <div className="p-4 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <TrendingUp className="h-4 w-4" />
                    <span className="text-xs">Response Rate</span>
                  </div>
                  <p className="text-2xl font-bold">{analytics.overallResponseRate}%</p>
                </div>
                <div className="p-4 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Users className="h-4 w-4" />
                    <span className="text-xs">Active Workers</span>
                  </div>
                  <p className="text-2xl font-bold">{analytics.activeWorkers}</p>
                </div>
                <div className="p-4 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Clock className="h-4 w-4" />
                    <span className="text-xs">Avg Response</span>
                  </div>
                  <p className="text-2xl font-bold">
                    {analytics.avgCheckinResponseMinutes > 0 
                      ? `${analytics.avgCheckinResponseMinutes}m` 
                      : 'N/A'}
                  </p>
                </div>
              </div>

              {/* Top Commands */}
              {analytics.topCommands.length > 0 && (
                <div>
                  <Label className="text-sm text-muted-foreground mb-2 block">Most Used Commands</Label>
                  <div className="flex flex-wrap gap-2">
                    {analytics.topCommands.map((cmd) => (
                      <Badge key={cmd.command} variant="secondary">
                        @bot {cmd.command}: {cmd.count}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Worker Engagement */}
              {engagement.length > 0 && (
                <div>
                  <Label className="text-sm text-muted-foreground mb-2 block">Worker Engagement</Label>
                  <div className="space-y-2">
                    {engagement.slice(0, 5).map((worker) => (
                      <div 
                        key={worker.workerId} 
                        className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                      >
                        <div>
                          <p className="font-medium text-sm">{worker.workerName}</p>
                          <p className="text-xs text-muted-foreground">
                            {worker.totalCheckins} check-ins, {worker.responded} responded
                          </p>
                        </div>
                        <div className="text-right">
                          <Badge 
                            variant={worker.responseRate >= 80 ? 'default' : worker.responseRate >= 50 ? 'secondary' : 'destructive'}
                          >
                            {worker.responseRate}% response rate
                          </Badge>
                          {worker.avgResponseMinutes > 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Avg: {worker.avgResponseMinutes}m
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <BarChart3 className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No analytics data yet</p>
              <p className="text-xs">Data will appear after bot interactions</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Worker Compliance Dashboard */}
      <ComplianceDashboard />

      {/* How to Get Model ID */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How to Find Model IDs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            <strong>Board ID:</strong> Open a Trello board, add <code>.json</code> to the URL, 
            and look for the <code>id</code> field. Or use the board's short link.
          </p>
          <p>
            <strong>Workspace ID:</strong> Go to your workspace settings, the ID is in the URL 
            after <code>/w/</code>.
          </p>
          <p>
            <strong>Card ID:</strong> Open a card, the ID is the alphanumeric string in the URL 
            after <code>/c/</code>.
          </p>
          <a 
            href="https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/" 
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Trello Webhook Documentation
            <ExternalLink className="h-3 w-3" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}

export default ChatbotSettings;
