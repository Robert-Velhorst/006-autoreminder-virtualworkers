import { useEffect, useState, type FormEvent } from "react";
import { useRoute } from "wouter";
import { CheckCircle2, KeyRound, Loader2, MailCheck, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type InvitationDetails = {
  name: string;
  email: string;
  expiresAt: string;
};

export default function WorkerInvitationAcceptance() {
  const [, params] = useRoute("/accept-invite/:token");
  const token = params?.token ?? "";
  const [details, setDetails] = useState<InvitationDetails | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function loadInvitation() {
      try {
        const response = await fetch(`/api/worker-invitations/${encodeURIComponent(token)}`, {
          signal: controller.signal,
        });
        const result = await response.json() as InvitationDetails & { error?: string };
        if (!response.ok) throw new Error(result.error || "This invitation is unavailable.");
        setDetails(result);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "This invitation is unavailable.");
      } finally {
        setLoading(false);
      }
    }
    void loadInvitation();
    return () => controller.abort();
  }, [token]);

  async function acceptInvitation(event: FormEvent) {
    event.preventDefault();
    if (password.length < 12) {
      setError("Use at least 12 characters for your password.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/worker-invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json() as { error?: string; redirectTo?: string };
      if (!response.ok) throw new Error(result.error || "The invitation could not be accepted.");
      window.location.assign(result.redirectTo || "/worker/settings?onboarding=1");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The invitation could not be accepted.");
      setSaving(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-lg space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MailCheck className="size-5" aria-hidden="true" />
          </div>
          <div>
            <div className="font-semibold">Virtual Worker Dashboard</div>
            <div className="text-sm text-muted-foreground">Secure account setup</div>
          </div>
        </div>

        <ol className="grid grid-cols-3 gap-2 text-xs" aria-label="Account setup progress">
          <li className="border-t-2 border-primary pt-2 font-medium">1. Account</li>
          <li className="border-t-2 border-border pt-2 text-muted-foreground">2. Work sources</li>
          <li className="border-t-2 border-border pt-2 text-muted-foreground">3. Browser</li>
        </ol>

        <Card className="rounded-lg">
          {loading ? (
            <CardContent className="flex min-h-64 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Checking invitation" />
            </CardContent>
          ) : details ? (
            <>
              <CardHeader>
                <CardTitle>Welcome, {details.name}</CardTitle>
                <CardDescription>Choose the password you will use to access your worker dashboard.</CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={acceptInvitation}>
                  <div className="rounded-md border bg-muted/30 p-3 text-sm">
                    <div className="text-xs text-muted-foreground">Account email</div>
                    <div className="mt-1 font-medium">{details.email}</div>
                  </div>
                  {error && (
                    <Alert variant="destructive">
                      <ShieldAlert className="size-4" />
                      <AlertTitle>Account setup needs attention</AlertTitle>
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="worker-password">Password</Label>
                    <Input id="worker-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required />
                    <p className="text-xs text-muted-foreground">At least 12 characters.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="worker-password-confirmation">Confirm password</Label>
                    <Input id="worker-password-confirmation" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} required />
                  </div>
                  <Button className="w-full" type="submit" disabled={saving}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                    Activate account
                  </Button>
                </form>
              </CardContent>
            </>
          ) : (
            <CardContent className="space-y-4 py-8 text-center">
              <ShieldAlert className="mx-auto size-6 text-destructive" aria-hidden="true" />
              <div>
                <h1 className="font-semibold">Invitation unavailable</h1>
                <p className="mt-1 text-sm text-muted-foreground">{error || "Ask the dashboard owner for a new invitation."}</p>
              </div>
              <Button variant="outline" asChild><a href="/">Return to sign in</a></Button>
            </CardContent>
          )}
        </Card>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          The invitation is single-use and expires after 48 hours.
        </div>
      </div>
    </main>
  );
}
