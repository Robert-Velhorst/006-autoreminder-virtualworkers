import { useState } from "react";
import { Bot, CheckCircle2, Copy, KeyRound, Loader2, RotateCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function HaiConnectorSettings() {
  const utils = trpc.useUtils();
  const status = trpc.haiConnector.status.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const rotate = trpc.haiConnector.rotate.useMutation({
    onSuccess: (result) => {
      setIssuedToken(result.token);
      void utils.haiConnector.status.invalidate();
      toast.success("A new HAI connector key was created");
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = trpc.haiConnector.revoke.useMutation({
    onSuccess: () => {
      setIssuedToken(null);
      void utils.haiConnector.status.invalidate();
      toast.success("HAI connector access was revoked");
    },
    onError: (error) => toast.error(error.message),
  });

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(message);
    } catch {
      toast.error("Clipboard access was blocked");
    }
  };

  const feedUrl = `${window.location.origin}${status.data?.feedPath ?? "/api/integrations/hai/feed"}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Bot className="size-5" />HAI Worker Control</CardTitle>
        <CardDescription>Give HAI a bounded, read-only stream of commitment and reminder events. HAI cannot change work, send reminders, or act in connected accounts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Checking connector</div>
        ) : status.data?.configured ? (
          <Alert>
            <CheckCircle2 className="size-4" />
            <AlertTitle>Connector key active</AlertTitle>
            <AlertDescription>
              {status.data.token?.tokenPrefix}... · read only
              {status.data.token?.lastUsedAt ? ` · last read ${new Date(status.data.token.lastUsedAt).toLocaleString()}` : " · not read yet"}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <KeyRound className="size-4" />
            <AlertTitle>Connector not configured</AlertTitle>
            <AlertDescription>Create one revocable key, then add it to the local HAI connector settings.</AlertDescription>
          </Alert>
        )}

        {issuedToken && (
          <Alert>
            <KeyRound className="size-4" />
            <AlertTitle>New key, shown once</AlertTitle>
            <AlertDescription className="space-y-3">
              <p className="break-all font-mono text-xs">{issuedToken}</p>
              <Button size="sm" variant="outline" onClick={() => void copy(issuedToken, "HAI key copied")}><Copy className="size-4" />Copy key</Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3 rounded-md border p-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <p className="font-medium">Read-only feed</p>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={feedUrl}>{feedUrl}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void copy(feedUrl, "Feed address copied")}><Copy className="size-4" />Copy address</Button>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {status.data?.configured && (
            <Button variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending || rotate.isPending}>
              {revoke.isPending ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}Revoke
            </Button>
          )}
          <Button onClick={() => rotate.mutate({})} disabled={rotate.isPending || revoke.isPending}>
            {rotate.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
            {status.data?.configured ? "Rotate key" : "Create key"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
