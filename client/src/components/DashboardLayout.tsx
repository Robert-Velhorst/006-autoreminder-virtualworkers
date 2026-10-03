import { useAuth } from "@/_core/hooks/useAuth";
import { Loader2, RefreshCw, WifiOff } from "lucide-react";
import React, { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { toast } from "sonner";

const AdminDashboardShell = lazy(() => import("./AdminDashboardShell"));

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { loading, user, verificationUnavailable, checking, refresh } = useAuth();
  const [location] = useLocation();

  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  if (!user) {
    if (location === '/trello-callback') {
      return <TrelloCallbackPage />;
    }
    if (verificationUnavailable) {
      return <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <section role="alert" className="w-full max-w-md space-y-4">
          <WifiOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-xl font-semibold">Dashboard temporarily unavailable</h1>
          <p className="text-sm text-muted-foreground">Your access cannot be checked right now. You do not need to reset your password. We will reconnect automatically.</p>
          <Button disabled={checking} onClick={() => void refresh()}>
            <RefreshCw className={`mr-2 h-4 w-4${checking ? " animate-spin" : ""}`} aria-hidden="true" />
            {checking ? "Checking connection" : "Try again"}
          </Button>
        </section>
      </main>;
    }
    return <LocalLoginForm onSuccess={() => window.location.href = '/'} />;
  }

  if (user.role === 'worker') {
    return <>
      {verificationUnavailable && <div role="alert" className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        Connection interrupted. Your page is kept open. Wait for reconnection before saving changes.
      </div>}
      {children}
    </>;
  }

  return (
    <Suspense fallback={<DashboardLayoutSkeleton />}>
      <AdminDashboardShell>{children}</AdminDashboardShell>
    </Suspense>
  );
}

// ─── Trello Callback Page ───────────────────────────────────────────────────
function TrelloCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(true);

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const hash = window.location.hash || '';
        const params = new URLSearchParams(hash.substring(1)); // strip '#'
        const token = params.get('token');

        if (!token) {
          setError('No authorization token received from Trello.');
          setProcessing(false);
          return;
        }

        const response = await fetch('/api/auth/trello/login-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const data = await response.json();
        if (!response.ok) {
          setError(data.error || 'Authentication with Trello failed.');
          setProcessing(false);
          return;
        }

        toast.success('Successfully logged in with Trello!');
        window.location.href = '/worker';
      } catch (err) {
        console.error('Trello login callback error:', err);
        setError('A network error occurred. Please try again.');
        setProcessing(false);
      }
    };

    handleCallback();
  }, []);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-sm p-8 space-y-6 border rounded-xl shadow-sm bg-card text-center">
        <h1 className="text-xl font-semibold tracking-tight">Trello Authentication</h1>
        
        {processing && (
          <div className="space-y-4">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Verifying Trello session...</p>
          </div>
        )}

        {error && (
          <div className="space-y-4">
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-3 rounded-md leading-relaxed">
              {error}
            </div>
            <Button onClick={() => window.location.href = '/'} className="w-full">
              Back to Login
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Local Login Form ────────────────────────────────────────────────────────
// Replaces Manus OAuth for local development. Uses username/password auth.

function LocalLoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'owner-setup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [ownerSetupAvailable, setOwnerSetupAvailable] = useState(false);
  const [localPreviewAvailable, setLocalPreviewAvailable] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (window.location.hostname !== '127.0.0.1' || window.location.port !== '3052') return;
    let active = true;
    void fetch('/__local-preview/status')
      .then(response => response.ok ? response.json() : null)
      .then(result => { if (active) setLocalPreviewAvailable(result?.available === true); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void fetch('/api/auth/owner-bootstrap/status')
      .then((response) => response.ok ? response.json() : { available: false })
      .then((result) => { if (active) setOwnerSetupAvailable(Boolean(result.available)); })
      .catch(() => { if (active) setOwnerSetupAvailable(false); });
    return () => { active = false; };
  }, []);

  const handleTrelloLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/trello/client-key');
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch Trello key');
      }
      const { apiKey, returnUrl } = await res.json() as { apiKey: string; returnUrl?: string | null };
      const redirectUrl = returnUrl || (import.meta.env.DEV ? `${window.location.origin}/trello-callback` : null);
      if (!redirectUrl) {
        throw new Error('Trello sign-in is not configured with a public callback URL. Set TRELLO_LOGIN_RETURN_URL or PUBLIC_URL.');
      }
      const authorizationUrl = new URL('https://trello.com/1/authorize');
      authorizationUrl.search = new URLSearchParams({
        expiration: '1day',
        name: 'VA Dashboard',
        scope: 'read',
        response_type: 'token',
        callback_method: 'fragment',
        key: apiKey,
        return_url: redirectUrl,
      }).toString();
      window.location.assign(authorizationUrl.toString());
    } catch (e) {
      console.error('Trello redirect error:', e);
      const errMsg = e instanceof Error ? e.message : 'Failed to redirect to Trello';
      setError(errMsg);
      toast.error('Trello Login Failed', { description: errMsg });
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === 'owner-setup' && password !== confirmPassword) {
        setError('The passwords do not match');
        return;
      }
      const endpoint = mode === 'login'
        ? '/api/auth/login'
        : mode === 'register'
          ? '/api/auth/register'
          : '/api/auth/owner-bootstrap';
      const body = mode === 'login'
        ? { username, password }
        : mode === 'register'
          ? { username, password, name }
          : { token: setupToken, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        const errorMessage = data.error || 'Something went wrong';
        setError(errorMessage);
        
        // Show error toast
        if (mode === 'register' || mode === 'owner-setup') {
          toast.error('Registration Failed', {
            description: errorMessage,
            duration: 5000,
          });
        } else {
          toast.error('Login Failed', {
            description: errorMessage,
            duration: 5000,
          });
        }
        return;
      }

      // Show success toast
      if (mode === 'register') {
        toast.success('Account Created Successfully!', {
          description: `Welcome, ${name || username}! Redirecting to dashboard...`,
          duration: 3000,
        });
      } else if (mode === 'owner-setup') {
        toast.success('Owner Access Configured', {
          description: 'The one-time setup is now closed.',
          duration: 3000,
        });
      } else {
        toast.success('Login Successful!', {
          description: `Welcome back, ${username}!`,
          duration: 3000,
        });
      }

      // Small delay to show the success message before redirecting
      setTimeout(() => {
        onSuccess();
      }, 500);
    } catch (error) {
      const errorMessage = 'Network error — is the server running?';
      setError(errorMessage);
      toast.error('Connection Error', {
        description: errorMessage,
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-sm p-8 space-y-6 border rounded-xl shadow-sm bg-card">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">VA Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {mode === 'login' ? 'Sign in to your account' : mode === 'register' ? 'Create a new account' : 'Configure one-time owner access'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Display Name</Label>
              <Input
                id="name"
                placeholder="Your name"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={loading}
              />
            </div>
          )}

          {mode === 'owner-setup' && <div className="space-y-1.5">
            <Label htmlFor="setup-token">Setup token</Label>
            <Input id="setup-token" type="password" autoComplete="one-time-code" placeholder="Enter the local setup token" value={setupToken} onChange={e => setSetupToken(e.target.value)} disabled={loading} required />
          </div>}

          {mode !== 'owner-setup' && <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              placeholder="Enter username"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={loading}
              required
            />
          </div>}

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Enter password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={loading}
              minLength={mode === 'login' ? undefined : 12}
              required
            />
          </div>

          {mode === 'owner-setup' && <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm password</Label>
            <Input id="confirm-password" type="password" autoComplete="new-password" placeholder="Repeat the password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} disabled={loading} minLength={12} required />
          </div>}

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Configure owner access'}
          </Button>
          {mode === 'login' && localPreviewAvailable && <div className="space-y-2">
            <Button type="button" variant="outline" className="w-full" disabled={loading} onClick={() => window.location.assign('http://127.0.0.1:3053/worker')}>Overslaan - lokale toegang</Button>
            <p className="text-xs text-muted-foreground">Alleen op deze computer. Je werkt met echte gegevens; opgeslagen wijzigingen zijn echt.</p>
          </div>}

          {mode === 'login' && (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">Or continue with</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full flex items-center justify-center gap-2 border-primary/20 hover:bg-primary/5 hover:text-primary transition-all duration-200"
                onClick={handleTrelloLogin}
                disabled={loading}
              >
                <svg className="w-4 h-4 fill-current text-[#0079BF]" viewBox="0 0 24 24">
                  <path d="M19.5 2h-15A2.5 2.5 0 002 4.5v15A2.5 2.5 0 004.5 22h15a2.5 2.5 0 002.5-2.5v-15A2.5 2.5 0 0019.5 2zM10 17.5a1 1 0 01-1 1H6a1 1 0 01-1-1v-11a1 1 0 011-1h3a1 1 0 011 1v11zm9-4a1 1 0 01-1 1h-3a1 1 0 01-1-1v-7a1 1 0 011-1h3a1 1 0 011 1v7z"/>
                </svg>
                Sign in with Trello
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Linked worker accounts sign in with Trello.
              </p>
            </>
          )}
        </form>

        {mode === 'login' && ownerSetupAvailable && <Button variant="ghost" className="w-full" onClick={() => { setMode('owner-setup'); setError(null); }}>
          Set up owner access
        </Button>}
        {mode === 'owner-setup' && <Button variant="ghost" className="w-full" onClick={() => { setMode('login'); setError(null); }}>
          Back to sign in
        </Button>}

        {import.meta.env.DEV && <p className="text-center text-sm text-muted-foreground">
          {mode === 'login' ? (
            <>
              No account?{' '}
              <button
                onClick={() => { setMode('register'); setError(null); }}
                className="underline hover:text-foreground transition-colors"
              >
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                onClick={() => { setMode('login'); setError(null); }}
                className="underline hover:text-foreground transition-colors"
              >
                Sign in
              </button>
            </>
          )}
        </p>}
      </div>
    </div>
  );
}
