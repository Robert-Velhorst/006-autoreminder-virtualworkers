import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, TrendingUp, TrendingDown, Activity, Zap, Database, Wifi, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface PerformanceMetrics {
  cache: {
    hits: number;
    misses: number;
    totalRequests: number;
    hitRate: number;
    missRate: number;
    lastUpdated: string;
  };
  queue: {
    totalRequests: number;
    uniqueRequests: number;
    deduplicatedRequests: number;
    deduplicationRate: number;
    activeRequests: number;
    pendingRequests: number;
  };
  websocket: {
    connected: boolean;
    totalClients: number;
    userClients: number;
    totalUsers: number;
    status: string;
  };
  performance: {
    apiCallsSaved: number;
    apiCallReduction: number;
    timeSavedMs: number;
    timeSavedSeconds: number;
    avgCacheHitTime: number;
    avgApiCallTime: number;
  };
  summary: {
    overallHealth: string;
    recommendations: string[];
  };
}

interface PerformanceMetricsProps {
  showSection?: 'cache' | 'queue' | 'websocket';
}

export function PerformanceMetrics({ showSection }: PerformanceMetricsProps = {}) {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => document.visibilityState === 'visible',
  );

  const handleClearCache = async () => {
    if (!window.confirm('Are you sure you want to clear the cache? This will reset all cached data.')) {
      return;
    }

    setClearingCache(true);
    try {
      const response = await fetch('/api/cache', { method: 'DELETE' });
      if (!response.ok) throw new Error('Cache clear request failed');
      await fetchMetrics();
      
      toast.success('Cache cleared successfully');
    } catch (error) {
      console.error('Error clearing cache:', error);
      toast.error('Failed to clear cache');
    } finally {
      setClearingCache(false);
    }
  };

  const fetchMetrics = async (showToast = false) => {
    try {
      setRefreshing(true);
      const response = await fetch('/api/metrics/performance');
      
      if (!response.ok) {
        throw new Error('Failed to fetch metrics');
      }

      const data = await response.json();
      setMetrics(data);
      
      if (showToast) {
        toast.success('Metrics refreshed');
      }
    } catch (error) {
      console.error('Error fetching metrics:', error);
      setMetrics(null);
      if (showToast) {
        toast.error('Performance metrics are unavailable');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const syncVisibility = () => setIsDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  useEffect(() => {
    if (!isDocumentVisible) return;
    void fetchMetrics();
    const interval = setInterval(() => void fetchMetrics(), 30000);
    return () => clearInterval(interval);
  }, [isDocumentVisible]);

  // Show loading state only briefly, then show error or content
  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Loading Performance Metrics...
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // Show empty state if metrics failed to load
  if (!metrics) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Performance Metrics</span>
              <Button variant="outline" size="sm" onClick={() => fetchMetrics(true)}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </CardTitle>
            <CardDescription>
              Unable to load performance metrics. This may be due to authentication or server issues.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const getHealthColor = (health: string) => {
    switch (health) {
      case 'excellent':
        return 'bg-green-500';
      case 'good':
        return 'bg-blue-500';
      case 'poor':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getHealthBadge = (health: string) => {
    switch (health) {
      case 'excellent':
        return <Badge className="bg-green-500">Excellent</Badge>;
      case 'good':
        return <Badge className="bg-blue-500">Good</Badge>;
      case 'poor':
        return <Badge className="bg-yellow-500">Needs Improvement</Badge>;
      default:
        return <Badge>Unknown</Badge>;
    }
  };

  const showAllSections = !showSection;
  const showCache = !showSection || showSection === 'cache';
  const showQueue = !showSection || showSection === 'queue';
  const showWebsocket = !showSection || showSection === 'websocket';

  return (
    <div className="space-y-6">
      {/* Header - only show when displaying all sections */}
      {showAllSections && (
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Performance Metrics</h2>
            <p className="text-muted-foreground">
              Monitor cache, queue, and WebSocket performance
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchMetrics(true)}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      )}



      {/* Cache Performance */}
      {showCache && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Cache Performance
            </CardTitle>
            <CardDescription>Database caching performance and hit rates</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Total Requests</p>
                <p className="text-2xl font-bold">{metrics.cache.totalRequests}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Cache Hits</p>
                <p className="text-2xl font-bold text-green-600">{metrics.cache.hits}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Cache Misses</p>
                <p className="text-2xl font-bold text-yellow-600">{metrics.cache.misses}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Hit Rate</p>
                <p className="text-2xl font-bold text-blue-600">{metrics.cache.hitRate}%</p>
              </div>
            </div>
            <div className="pt-4 border-t">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Cache Hit Rate Progress</span>
                <span className="text-sm text-muted-foreground">{metrics.cache.hitRate}%</span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 transition-all"
                  style={{ width: `${metrics.cache.hitRate}%` }}
                />
              </div>
            </div>
            <div className="pt-4 border-t space-y-3">
              <p className="text-xs text-muted-foreground">
                Last updated: {new Date(metrics.cache.lastUpdated).toLocaleString()}
              </p>
              <Button 
                variant="destructive" 
                size="sm"
                onClick={handleClearCache}
                disabled={clearingCache}
                className="w-full"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {clearingCache ? 'Clearing...' : 'Clear Cache'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Request Queue */}
      {showQueue && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5" />
              Request Queue
            </CardTitle>
            <CardDescription>Request deduplication and queue performance</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Total Requests</p>
                <p className="text-2xl font-bold">{metrics.queue.totalRequests}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Unique Requests</p>
                <p className="text-2xl font-bold text-blue-600">{metrics.queue.uniqueRequests}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Deduplicated</p>
                <p className="text-2xl font-bold text-green-600">{metrics.queue.deduplicatedRequests}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Dedup Rate</p>
                <p className="text-2xl font-bold">{metrics.queue.deduplicationRate}%</p>
              </div>
            </div>
            <div className="pt-4 border-t">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Deduplication Rate</span>
                <span className="text-sm text-muted-foreground">{metrics.queue.deduplicationRate}%</span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${metrics.queue.deduplicationRate}%` }}
                />
              </div>
            </div>
            <div className="pt-2 border-t">
              <p className="text-xs text-muted-foreground">
                Active: {metrics.queue.activeRequests} | Pending: {metrics.queue.pendingRequests}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* WebSocket Status */}
      {showWebsocket && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wifi className="h-5 w-5" />
              WebSocket Status
            </CardTitle>
            <CardDescription>Real-time WebSocket connection status</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className={`h-4 w-4 rounded-full ${metrics.websocket.connected ? 'bg-green-500' : 'bg-gray-400'}`} />
              <div>
                <p className="font-medium capitalize">{metrics.websocket.status}</p>
                <p className="text-sm text-muted-foreground">
                  {metrics.websocket.connected ? 'Connection active' : 'Connection inactive'}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 pt-4 border-t">
              <div>
                <p className="text-sm text-muted-foreground">Total Clients</p>
                <p className="text-2xl font-bold">{metrics.websocket.totalClients}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Users</p>
                <p className="text-2xl font-bold text-blue-600">{metrics.websocket.totalUsers}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">User Clients</p>
                <p className="text-2xl font-bold text-green-600">{metrics.websocket.userClients}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Avg Clients/User</p>
                <p className="text-2xl font-bold">{metrics.websocket.totalUsers > 0 ? (metrics.websocket.totalClients / metrics.websocket.totalUsers).toFixed(1) : '0.0'}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Key Metrics Grid - only show when displaying all sections */}
      {showAllSections && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Cache Hit Rate */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Database className="h-4 w-4" />
                Cache Hit Rate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{metrics.cache.hitRate}%</div>
              <p className="text-xs text-muted-foreground mt-1">
                {metrics.cache.hits} hits / {metrics.cache.totalRequests} requests
              </p>
              <div className="mt-2 h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 transition-all"
                  style={{ width: `${metrics.cache.hitRate}%` }}
                />
              </div>
            </CardContent>
          </Card>

          {/* API Call Reduction */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingDown className="h-4 w-4" />
                API Call Reduction
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{metrics.performance.apiCallReduction}%</div>
              <p className="text-xs text-muted-foreground mt-1">
                {metrics.performance.apiCallsSaved} calls saved
              </p>
              <div className="mt-2 h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${metrics.performance.apiCallReduction}%` }}
                />
              </div>
            </CardContent>
          </Card>

          {/* Time Saved */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4" />
                Time Saved
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{metrics.performance.timeSavedSeconds}s</div>
              <p className="text-xs text-muted-foreground mt-1">
                Avg: {metrics.performance.avgCacheHitTime}ms vs {metrics.performance.avgApiCallTime}ms
              </p>
              <div className="mt-2 flex items-center gap-1 text-green-600">
                <TrendingUp className="h-3 w-3" />
                <span className="text-xs font-medium">
                  {Math.round((metrics.performance.avgApiCallTime / metrics.performance.avgCacheHitTime) * 10) / 10}x faster
                </span>
              </div>
            </CardContent>
          </Card>

          {/* WebSocket Status */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Wifi className="h-4 w-4" />
                WebSocket Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${metrics.websocket.connected ? 'bg-green-500' : 'bg-gray-400'}`} />
                <span className="text-2xl font-bold capitalize">{metrics.websocket.status}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {metrics.websocket.totalClients} clients / {metrics.websocket.totalUsers} users
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
