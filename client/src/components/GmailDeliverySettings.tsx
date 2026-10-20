import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, Loader2, Mail, ShieldCheck, Unplug } from "lucide-react";
import { toast } from "sonner";

type DeliveryStatus = {
  clientConfigured: boolean;
  connected: boolean;
  senderEmail: string | null;
  setupMessage: string | null;
};

export function GmailDeliverySettings() {
  const { user } = useAuth();
  const [status, setStatus] = useState<DeliveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/google-evidence/mail-delivery/status", { credentials: "include" });
      if (!response.ok) throw new Error("Unable to read Gmail delivery status");
      setStatus(await response.json() as DeliveryStatus);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to read Gmail delivery status");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === "admin") void refresh();
  }, [user?.role]);

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const response = await fetch("/api/google-evidence/mail-delivery/disconnect", {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Unable to disconnect Gmail delivery");
      toast.success("Gmail sending access removed");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to disconnect Gmail delivery");
    } finally {
      setDisconnecting(false);
    }
  };

  if (user?.role !== "admin") return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Mail className="size-5" />Gmail delivery</CardTitle>
        <CardDescription>Send approved dashboard emails from the owner mailbox without storing a Gmail password.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Checking connection</div> : status?.connected ? (
          <Alert>
            <CheckCircle2 className="size-4" />
            <AlertTitle>Connected</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>Dashboard email will send from {status.senderEmail} when notification delivery is enabled.</span>
              <Button variant="outline" size="sm" onClick={disconnect} disabled={disconnecting}>
                {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}Disconnect
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <ShieldCheck className="size-4" />
            <AlertTitle>Gmail sending is not connected</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{status?.setupMessage ?? "Checking Google OAuth configuration."}</span>
              {status?.clientConfigured && <Button size="sm" asChild><a href="/api/google-evidence/mail-delivery/connect">Connect owner Gmail</a></Button>}
            </AlertDescription>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground">This asks only for permission to send email. Gmail and Drive evidence remain read-only, and delivery stays disabled until the server enables notifications.</p>
      </CardContent>
    </Card>
  );
}
