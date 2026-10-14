import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { BulkBoardSelector } from '@/components/BulkBoardSelector';
import { TrelloIntegrationSettings } from '@/components/TrelloIntegrationSettings';

interface WebhookStatus {
  callbackUrl: string;
  publicUrl: string;
  isConfigured: boolean;
  isReachable: boolean | null;
  recommendation: string;
}

interface Webhook {
  id: string;
  trelloWebhookId: string;
  modelId: string;
  description?: string;
  isActive: number;
  createdAt?: string;
}

interface Analytics {
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

const retryFetch = async (url: string, retries: number = 2, delay: number = 500) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
    } catch (error) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      else throw error;
    }
  }
  throw new Error('Max retries exceeded');
};

/** Extract a human-readable board name from a webhook record.
 *  The description field is stored as "VA Dashboard Webhook for <boardId>" or
 *  "Chatbot for <boardName>" — we prefer the description when it looks like a
 *  real name, otherwise fall back to the raw modelId. */
function getBoardDisplayName(webhook: Webhook): string {
  if (webhook.description) {
    // Strip common prefixes added by the auto-register service
    const cleaned = webhook.description
      .replace(/^VA Dashboard (Chatbot|Webhook) (for |-\s*)/i, '')
      .replace(/^Chatbot for /i, '')
      .trim();
    // Only use it if it doesn't look like a raw board ID (all hex, 24 chars)
    if (cleaned && !/^[a-f0-9]{24}$/i.test(cleaned)) {
      return cleaned;
    }
  }
  return webhook.modelId;
}

export default function TrelloChatbotSettings() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  // Set of already-registered board IDs — passed to BulkBoardSelector for badges
  const registeredBoardIds = useMemo(
    () => new Set(webhooks.map(w => w.modelId)),
    [webhooks]
  );

  useEffect(() => {
    loadWebhookStatus();
    const webhooksTimer = setTimeout(() => loadWebhooks(), 300);
    const analyticsTimer = setTimeout(() => loadAnalytics(), 600);
    return () => {
      clearTimeout(webhooksTimer);
      clearTimeout(analyticsTimer);
    };
  }, []);

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
      const response = await retryFetch('/api/trello-webhook/list', 2, 500);
      if (response.ok) {
        const data = await response.json();
        setWebhooks(data.webhooks || []);
      } else {
        const errorText = await response.text();
        console.error('[TrelloChatbot] Failed to load webhooks:', response.status, errorText);
        if (response.status !== 503) {
          toast.error(`Failed to load webhooks: ${response.status}`);
        }
      }
    } catch (error) {
      console.error('[TrelloChatbot] Error loading webhooks:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadAnalytics = async () => {
    setLoadingAnalytics(true);
    try {
      const response = await retryFetch('/api/chatbot/analytics', 2, 500);
      const responseText = await response.text();

      if (!response.ok) {
        console.error('Analytics API error - status:', response.status);
        if (response.status !== 503) {
          console.error('Response:', responseText.substring(0, 200));
        }
        return;
      }

      try {
        const data = JSON.parse(responseText);
        setAnalytics(data);
      } catch (parseError) {
        console.error('Failed to parse analytics response as JSON:', parseError);
      }
    } catch (error) {
      console.error('Error loading analytics:', error);
    } finally {
      setLoadingAnalytics(false);
    }
  };

  const deleteWebhook = async (webhookId: string) => {
    try {
      const response = await fetch(`/api/trello-webhook/${webhookId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        toast.success('Webhook deleted successfully');
        await loadWebhooks();
      } else {
        toast.error('Failed to delete webhook');
      }
    } catch (error) {
      console.error('Error deleting webhook:', error);
      toast.error('Failed to delete webhook');
    }
  };

  /** Handler passed to BulkBoardSelector — returns results so the selector can
   *  display them in BulkRegistrationProgress without needing a separate state here. */
  const handleBulkRegister = async (
    selectedBoardIds: string[],
    boardNames: Record<string, string>
  ) => {
    setRegistering(true);
    try {
      const response = await fetch('/api/trello-webhook/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardIds: selectedBoardIds,
          // The server uses the verified TRELLO_WEBHOOK_CALLBACK_URL setting.
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        const msg = errorData.error || 'Bulk registration failed';
        toast.error(msg);
        return selectedBoardIds.map(id => ({ boardId: id, success: false, error: msg }));
      }

      const result = await response.json();
      console.log('[TrelloChatbotSettings] Bulk registration result:', result);

      await loadWebhooks();

      const { successful, failed } = result.summary;
      if (failed === 0) {
        toast.success(`All ${successful} board${successful !== 1 ? 's' : ''} registered successfully`);
      } else if (successful === 0) {
        toast.error(`Registration failed for all ${failed} board${failed !== 1 ? 's' : ''}`);
      } else {
        toast.warning(`${successful} registered, ${failed} failed — see results below`);
      }

      return result.results ?? [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Bulk registration failed';
      console.error('[TrelloChatbotSettings] Bulk registration error:', error);
      toast.error(msg);
      return selectedBoardIds.map(id => ({ boardId: id, success: false, error: msg }));
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-8 w-8 rounded bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
              T
            </div>
            Trello Chatbot Configuration
          </CardTitle>
          <CardDescription>Manage webhooks and monitor analytics</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="setup" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="labels">Labels</TabsTrigger>
              <TabsTrigger value="analytics">Analytics</TabsTrigger>
            </TabsList>

            {/* Setup Tab */}
            <TabsContent value="setup" className="space-y-4 mt-4">
              <div className="space-y-4">
                {webhooks.length > 0 && (
                  <div className="flex items-center gap-2 p-2 rounded-lg text-sm bg-green-50 border border-green-200 text-green-800">
                    <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
                    <span className="font-medium">
                      {webhooks.length} Webhook{webhooks.length !== 1 ? 's' : ''} Configured
                    </span>
                  </div>
                )}

                {/* Board registration */}
                <BulkBoardSelector
                  onRegister={handleBulkRegister}
                  isRegistering={registering}
                  registeredBoardIds={registeredBoardIds}
                />

                {/* Registered webhooks list — shows board names, not raw IDs */}
                {webhooks.length > 0 && (
                  <div className="mt-6">
                    <h3 className="font-semibold mb-3 flex items-center gap-2">
                      <CheckCircle className="h-4 w-4" />
                      Registered Webhooks
                    </h3>
                    <div className="space-y-2">
                      {webhooks.map((webhook) => {
                        const displayName = getBoardDisplayName(webhook);
                        const isNameDifferentFromId = displayName !== webhook.modelId;
                        return (
                          <div
                            key={webhook.id}
                            className="flex items-center justify-between p-3 border rounded-lg bg-gray-50"
                          >
                            <div className="min-w-0 flex-1">
                              {/* Board name as primary label */}
                              <p className="font-medium text-sm truncate">{displayName}</p>
                              {/* Show raw board ID as secondary info when we have a real name */}
                              {isNameDifferentFromId && (
                                <p className="text-xs text-gray-400 font-mono truncate">
                                  {webhook.modelId}
                                </p>
                              )}
                              <p className="text-xs text-gray-500">
                                {webhook.isActive ? 'Active' : 'Inactive'}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => deleteWebhook(webhook.trelloWebhookId)}
                              className="ml-2 flex-shrink-0"
                            >
                              <Trash2 className="h-4 w-4 text-red-600" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Labels Tab */}
            <TabsContent value="labels" className="space-y-4 mt-4">
              <TrelloIntegrationSettings />
            </TabsContent>

            {/* Analytics Tab */}
            <TabsContent value="analytics" className="space-y-4 mt-4">
              {loadingAnalytics ? (
                <div className="p-4 text-center text-gray-500">Loading analytics...</div>
              ) : analytics ? (
                <div className="grid grid-cols-2 gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Total Conversations</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{analytics.totalConversations}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Avg Response Time</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{analytics.avgResponseTimeMs}ms</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Active Cards</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{analytics.activeCards}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Active Workers</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{analytics.activeWorkers}</p>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <div className="p-4 text-center text-gray-500">No analytics data available</div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
