import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TrendingUp, TrendingDown, Target, Calendar, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { describeWeeklyTimeEvidence } from '../../../shared/weeklyProgressEvidence';

interface WeeklyProgressData {
  weekStart: string;
  weekEnd: string;
  actualHours: number;
  actualMinutes: number;
  weeklyHoursMin: number;
  weeklyHoursMax: number;
  dailyHoursMin: number;
  dailyHoursMax: number;
  dailyHours: Record<string, number>;
  progressPercent: number;
  onTrack: boolean;
  status: 'under' | 'on_track' | 'over';
}

interface ScheduledHoursData {
  totalScheduledHours: number;
  dailyScheduled: Record<string, number>;
}

export function WeeklyProgressDashboard() {
  const [progress, setProgress] = useState<WeeklyProgressData | null>(null);
  const [scheduledHours, setScheduledHours] = useState<ScheduledHoursData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    fetchWeeklyProgress();
    fetchScheduledHours();
  }, []);

  const fetchWeeklyProgress = async () => {
    try {
      const response = await fetch('/api/time-tracking/weekly-progress');
      if (response.ok) {
        const data = await response.json();
        if (data.complete === false || data.unresolvedEntryCount > 0) {
          setProgress(null);
          setError('History needs owner review');
          return;
        }
        if (data.complete !== true || data.unresolvedEntryCount !== 0) {
          setProgress(null);
          setError('History unavailable');
          return;
        }
        setError(null);
        setProgress(data);
      } else {
        setProgress(null);
        setError('Unable to load weekly progress');
      }
    } catch (err) {
      console.error('Error fetching weekly progress:', err);
      setError('Failed to load progress');
    } finally {
      setLoading(false);
    }
  };

  const fetchScheduledHours = async () => {
    try {
      // Fetch tasks to calculate scheduled hours for the week
      // Use the ATIS timeline-tasks endpoint which is the correct API
      const response = await fetch('/api/atis/timeline-tasks?limit=200&filter=all');
      if (response.ok) {
        const data = await response.json();
        const tasks = data.scheduled || data.tasks || [];
        
        // Calculate scheduled hours for current week
        const weekStart = new Date(getWeekStart());
        const weekEnd = new Date(getWeekEnd());
        weekEnd.setHours(23, 59, 59, 999);
        
        let totalScheduledMinutes = 0;
        const dailyScheduled: Record<string, number> = {};
        
        tasks.forEach((task: any) => {
          if (task.dueDate && task.estimatedMinutes) {
            const taskDate = new Date(task.dueDate);
            if (taskDate >= weekStart && taskDate <= weekEnd) {
              const dateStr = taskDate.toISOString().split('T')[0];
              const minutes = task.estimatedMinutes || 30;
              totalScheduledMinutes += minutes;
              dailyScheduled[dateStr] = (dailyScheduled[dateStr] || 0) + minutes;
            }
          }
        });
        
        setScheduledHours({
          totalScheduledHours: Math.round(totalScheduledMinutes / 60 * 10) / 10,
          dailyScheduled
        });
      }
    } catch (err) {
      console.error('Error fetching scheduled hours:', err);
    }
  };

  const getWeekStart = () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1)); // Monday
    startOfWeek.setHours(0, 0, 0, 0);
    return startOfWeek.toISOString().split('T')[0];
  };

  const getWeekEnd = () => {
    const startOfWeek = new Date(getWeekStart());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6); // Sunday
    return endOfWeek.toISOString().split('T')[0];
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getDayName = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  };

  // Get gradient color based on fill percentage (light green to dark green)
  const getGradientColor = (fillPercent: number) => {
    if (fillPercent === 0) return 'bg-secondary';
    if (fillPercent <= 25) return 'bg-gradient-to-t from-green-200 to-green-100';
    if (fillPercent <= 50) return 'bg-gradient-to-t from-green-400 to-green-200';
    if (fillPercent <= 75) return 'bg-gradient-to-t from-green-500 to-green-300';
    if (fillPercent <= 100) return 'bg-gradient-to-t from-green-600 to-green-400';
    return 'bg-gradient-to-t from-green-700 to-green-500'; // Over capacity
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6">
          <div className="flex items-center justify-center">
            <Clock className="h-5 w-5 animate-spin mr-2" />
            <span className="text-muted-foreground">Loading progress...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !progress) {
    return (
      <Card>
        <CardContent className="py-6">
          <div role="status" className="text-center text-muted-foreground">
            {error || 'Unable to load weekly progress'}
          </div>
        </CardContent>
      </Card>
    );
  }

  const targetMidpoint = (progress.weeklyHoursMin + progress.weeklyHoursMax) / 2;
  const scheduledTotal = scheduledHours?.totalScheduledHours || 0;
  const scheduledProgressPercent = Math.min(100, Math.round((scheduledTotal / targetMidpoint) * 100));
  const timeEvidence = describeWeeklyTimeEvidence(
    progress.actualHours,
    scheduledHours ? scheduledTotal : null,
  );

  // Generate week days for the chart
  const weekDays: string[] = [];
  const startDate = new Date(progress.weekStart);
  for (let i = 0; i < 7; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    weekDays.push(date.toISOString().split('T')[0]);
  }

  return (
    <Card>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-lg">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-lg">
                <TrendingUp className="h-5 w-5" />
                Weekly Progress
              </CardTitle>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        
        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            {/* Summary Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center p-2 bg-muted/50 rounded-lg">
                <div className="text-xs text-muted-foreground">Completion Rate</div>
                <div className="text-lg font-bold">{scheduledProgressPercent}%</div>
              </div>
              <div className="text-center p-2 bg-muted/50 rounded-lg">
                <div className="text-xs text-muted-foreground">Hours</div>
                <div className="text-lg font-bold">
                  {scheduledTotal}/{progress.weeklyHoursMin}
                </div>
              </div>
            </div>

            {/* Daily Breakdown with Gradient Bars */}
            <div className="pt-2">
              <div className="grid grid-cols-7 gap-1">
                {weekDays.map((date) => {
                  const scheduled = scheduledHours?.dailyScheduled[date] || 0;
                  const tracked = (progress.dailyHours[date] || 0) * 60; // Convert hours to minutes
                  const scheduledHrs = Math.round(scheduled / 60 * 10) / 10;
                  const isToday = date === new Date().toISOString().split('T')[0];
                  const maxDailyMinutes = progress.dailyHoursMax * 60;
                  const fillPercent = Math.min(120, Math.round((scheduled / maxDailyMinutes) * 100));
                  const trackedPercent = Math.min(100, Math.round((tracked / maxDailyMinutes) * 100));
                  
                  return (
                    <div 
                      key={date} 
                      className={cn(
                        "flex flex-col items-center p-1 rounded text-xs",
                        isToday && "ring-2 ring-primary ring-offset-1"
                      )}
                    >
                      <span className={cn(
                        "font-medium",
                        isToday && "text-primary"
                      )}>{getDayName(date)}</span>
                      <div className="w-full h-16 bg-secondary rounded mt-1 relative overflow-hidden">
                        {/* Scheduled hours - gradient fill from bottom */}
                        <div 
                          className={cn(
                            "absolute bottom-0 w-full transition-all duration-500 ease-out",
                            fillPercent === 0 ? 'bg-transparent' :
                            fillPercent <= 25 ? 'bg-gradient-to-t from-green-300 to-green-100' :
                            fillPercent <= 50 ? 'bg-gradient-to-t from-green-400 to-green-200' :
                            fillPercent <= 75 ? 'bg-gradient-to-t from-green-500 to-green-300' :
                            fillPercent <= 100 ? 'bg-gradient-to-t from-green-600 to-green-400' :
                            'bg-gradient-to-t from-red-500 to-orange-400' // Over capacity
                          )}
                          style={{ height: `${Math.min(fillPercent, 100)}%` }}
                        />
                        {/* Tracked hours overlay - darker shade */}
                        {trackedPercent > 0 && (
                          <div 
                            className="absolute bottom-0 w-full bg-green-700/60 transition-all duration-300"
                            style={{ height: `${trackedPercent}%` }}
                          />
                        )}
                        {/* Capacity indicator line */}
                        <div className="absolute w-full h-px bg-muted-foreground/30" style={{ bottom: '100%' }} />
                      </div>
                      <span className={cn(
                        "text-[10px] mt-1",
                        scheduledHrs > 0 ? "text-foreground font-medium" : "text-muted-foreground"
                      )}>
                        {scheduledHrs > 0 ? `${scheduledHrs}h` : '-'}
                      </span>
                    </div>
                  );
                })}
              </div>
              
              {/* Legend */}
              <div className="flex items-center justify-center gap-4 mt-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 bg-gradient-to-t from-green-500 to-green-300 rounded" />
                  <span>Scheduled</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 bg-green-700/60 rounded" />
                  <span>Tracked</span>
                </div>
              </div>
            </div>

            {/* Source-backed time evidence only. */}
            <div className="flex items-center justify-between pt-2 border-t text-sm">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-muted-foreground" />
                <span>Time evidence</span>
              </div>
              <span className={cn("font-bold", timeEvidence.tone === "attention" ? "text-destructive" : "text-foreground")}>
                {timeEvidence.label}
              </span>
            </div>
            <p className={cn("text-xs -mt-2", timeEvidence.tone === "attention" ? "text-destructive" : "text-muted-foreground")}>
              {timeEvidence.detail}
            </p>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export default WeeklyProgressDashboard;
