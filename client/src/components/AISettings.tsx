import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bot, CheckCircle2, ShieldCheck, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface SubscriptionStatus {
  provider: 'codex-subscription';
  configured: boolean;
  available?: boolean;
  model: string;
  managedBy?: 'local-bridge';
}

async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
  }
  return payload;
}

export function AISettings() {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await readJson(await fetch('/api/trello-webhook/ai-settings'));
      if (payload.config?.provider !== 'codex-subscription' || typeof payload.config.configured !== 'boolean'
        || typeof payload.config.model !== 'string' || !payload.config.model
        || (payload.config.available !== undefined && typeof payload.config.available !== 'boolean')) throw new Error('Invalid subscription status');
      setStatus(payload.config);
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : 'Could not load Codex subscription status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const testConnection = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const payload = await readJson(await fetch('/api/trello-webhook/test-ai', { method: 'POST' }));
      setTestResult(`${payload.model}: ${payload.message}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Codex subscription connection test failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bot className="size-5 text-primary" />
            <CardTitle>Codex subscription</CardTitle>
          </div>
          {!loading && status && (
            <Badge variant={!status.configured || status.available === false ? 'destructive' : 'secondary'}>
              {!status.configured ? 'Setup required' : status.available === true ? 'Bridge responding' : status.available === false ? 'Bridge unavailable' : 'Configured; not checked'}
            </Badge>
          )}
        </div>
        <CardDescription>
          Fixed subscription provider and model. Queue configuration and heartbeat status do not verify live inference.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex min-h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error && !status ? (
          <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Status unavailable</p>
              <p className="text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" size="icon" onClick={() => void loadStatus()} title="Refresh status">
              <RefreshCw className="size-4" />
            </Button>
          </div>
        ) : status ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Provider</p>
                <p className="mt-1 font-semibold">Codex subscription</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Policy model</p>
                <p className="mt-1 break-all font-mono text-sm">{status.model || 'Unavailable'}</p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3 text-sm">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-muted-foreground">
                Authentication stays in the private host runner. No API key is required, and credentials cannot be saved in the dashboard database.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {testResult && (
              <div className="flex items-start gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                <span>{testResult}</span>
              </div>
            )}

            <p className="text-xs text-muted-foreground">A connection test makes one inference request and may consume subscription usage.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => void loadStatus()} disabled={loading || testing}><RefreshCw className="size-4" />Refresh status</Button>
              <Button onClick={() => void testConnection()} disabled={!status.configured || status.available === false || testing}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Test subscription connection
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
