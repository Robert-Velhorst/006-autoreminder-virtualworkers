import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bot, CheckCircle2, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface OpenAIStatus {
  provider: 'openai';
  configured: boolean;
  model: string | null;
  managedBy: 'environment';
}

async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

export function AISettings() {
  const [status, setStatus] = useState<OpenAIStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await readJson(await fetch('/api/trello-webhook/ai-settings'));
      setStatus(payload.config);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load OpenAI status');
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
      setError(cause instanceof Error ? cause.message : 'OpenAI connection test failed');
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
            <CardTitle>OpenAI</CardTitle>
          </div>
          {!loading && status && (
            <Badge variant={status.configured ? 'default' : 'destructive'}>
              {status.configured ? 'Connected' : 'Setup required'}
            </Badge>
          )}
        </div>
        <CardDescription>
          One model provider for planning, task assessment, interviews, and worker guidance.
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
                <p className="mt-1 font-semibold">OpenAI</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Active model</p>
                <p className="mt-1 break-all font-mono text-sm">{status.model || 'Unavailable'}</p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3 text-sm">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-muted-foreground">
                The API key is stored in the server environment. It is never returned to this page or saved in the dashboard database.
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

            <div className="flex justify-end">
              <Button onClick={() => void testConnection()} disabled={!status.configured || testing}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Test connection
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
