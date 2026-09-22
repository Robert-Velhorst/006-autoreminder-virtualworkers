import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { canRescheduleCalendarTask } from './calendarInteraction';

interface Task {
  id: string;
  cardId: string;
  cardName: string;
  description: string;
  durationHours: number;
  startTime: string;
  endTime: string;
  date: string;
  isCompleted: boolean;
  priorityLevel: string;
  taskType?: string;
}

interface CalendarViewProps {
  tasks: Task[];
  onTaskClick?: (task: Task) => void;
  onTaskReschedule?: (taskId: string, newDate: string) => void;
  holidays?: string[];
  workingDays?: number[];
}

type ViewMode = 'month' | 'week';

export function CalendarView({ 
  tasks, 
  onTaskClick, 
  onTaskReschedule,
  holidays = [],
  workingDays = [1, 2, 3, 4, 5]
}: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const canReschedule = canRescheduleCalendarTask(onTaskReschedule);

  // Get week start (Monday)
  const getWeekStart = (date: Date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  };

  // Get month start
  const getMonthStart = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  };

  // Generate days for the current view
  const days = useMemo(() => {
    const result: Date[] = [];
    
    if (viewMode === 'week') {
      const weekStart = getWeekStart(currentDate);
      for (let i = 0; i < 7; i++) {
        const day = new Date(weekStart);
        day.setDate(weekStart.getDate() + i);
        result.push(day);
      }
    } else {
      const monthStart = getMonthStart(currentDate);
      const firstDayOfWeek = monthStart.getDay();
      const startOffset = firstDayOfWeek === 0 ? -6 : 1 - firstDayOfWeek;
      
      const calendarStart = new Date(monthStart);
      calendarStart.setDate(monthStart.getDate() + startOffset);
      
      for (let i = 0; i < 42; i++) {
        const day = new Date(calendarStart);
        day.setDate(calendarStart.getDate() + i);
        result.push(day);
      }
    }
    
    return result;
  }, [currentDate, viewMode]);

  // Group tasks by date
  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    tasks.forEach(task => {
      const dateKey = task.date;
      if (!map.has(dateKey)) {
        map.set(dateKey, []);
      }
      map.get(dateKey)!.push(task);
    });
    return map;
  }, [tasks]);

  // Navigation
  const navigate = (direction: 'prev' | 'next') => {
    const newDate = new Date(currentDate);
    if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() + (direction === 'next' ? 7 : -7));
    } else {
      newDate.setMonth(newDate.getMonth() + (direction === 'next' ? 1 : -1));
    }
    setCurrentDate(newDate);
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  // Format date for display
  const formatDateKey = (date: Date) => {
    return date.toISOString().split('T')[0];
  };

  // Check if date is today
  const isToday = (date: Date) => {
    const today = new Date();
    return formatDateKey(date) === formatDateKey(today);
  };

  // Check if date is in current month
  const isCurrentMonth = (date: Date) => {
    return date.getMonth() === currentDate.getMonth();
  };

  // Check if date is a working day
  const isWorkingDay = (date: Date) => {
    return workingDays.includes(date.getDay());
  };

  // Check if date is a holiday
  const isHoliday = (date: Date) => {
    return holidays.includes(formatDateKey(date));
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, task: Task) => {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, date: Date) => {
    e.preventDefault();
    if (draggedTask && onTaskReschedule) {
      const newDate = formatDateKey(date);
      if (newDate !== draggedTask.date) {
        onTaskReschedule(draggedTask.id, newDate);
      }
    }
    setDraggedTask(null);
  };

  const handleDragEnd = () => {
    setDraggedTask(null);
  };

  // Get priority color
  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'CRITICAL': return 'bg-red-500 text-white';
      case 'URGENT': return 'bg-orange-500 text-white';
      case 'HIGH': return 'bg-yellow-500 text-black';
      default: return 'bg-blue-500 text-white';
    }
  };

  // Header with navigation
  const headerText = viewMode === 'week'
    ? `${days[0]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${days[6]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <CalendarIcon className="h-5 w-5" />
            Calendar
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="flex border rounded-lg overflow-hidden">
              <Button
                variant={viewMode === 'week' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('week')}
                className="rounded-none"
              >
                Week
              </Button>
              <Button
                variant={viewMode === 'month' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('month')}
                className="rounded-none"
              >
                Month
              </Button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => navigate('prev')}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={() => navigate('next')}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={goToToday}>
              Today
            </Button>
          </div>
          <span className="font-medium">{headerText}</span>
        </div>
      </CardHeader>
      <CardContent className="p-2">
        {/* Day headers */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
            <div key={day} className="text-center text-xs font-medium text-muted-foreground py-1">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className={cn(
          "grid grid-cols-7 gap-1",
          viewMode === 'week' ? 'grid-rows-1' : 'grid-rows-6'
        )}>
          {days.map((date, index) => {
            const dateKey = formatDateKey(date);
            const dayTasks = tasksByDate.get(dateKey) || [];
            const isNonWorking = !isWorkingDay(date) || isHoliday(date);
            
            return (
              <div
                key={index}
                className={cn(
                  "border rounded-lg p-1 transition-colors",
                  viewMode === 'week' ? 'min-h-[300px]' : 'min-h-[80px]',
                  isToday(date) && 'border-primary border-2',
                  !isCurrentMonth(date) && viewMode === 'month' && 'opacity-50',
                  isNonWorking && 'bg-muted/50',
                  canReschedule && draggedTask && 'hover:bg-primary/10'
                )}
                onDragOver={canReschedule ? handleDragOver : undefined}
                onDrop={canReschedule ? (e) => handleDrop(e, date) : undefined}
              >
                <div className={cn(
                  "text-xs font-medium mb-1 flex items-center justify-between",
                  isToday(date) && 'text-primary'
                )}>
                  <span>{date.getDate()}</span>
                  {isHoliday(date) && (
                    <Badge variant="outline" className="text-[10px] px-1">Holiday</Badge>
                  )}
                </div>
                
                <div className="space-y-1 overflow-y-auto" style={{ maxHeight: viewMode === 'week' ? '260px' : '50px' }}>
                  {dayTasks.slice(0, viewMode === 'week' ? undefined : 3).map(task => (
                    <div
                      key={task.id}
                      draggable={canReschedule}
                      onDragStart={canReschedule ? (e) => handleDragStart(e, task) : undefined}
                      onDragEnd={canReschedule ? handleDragEnd : undefined}
                      onClick={() => onTaskClick?.(task)}
                      className={cn(
                        "group text-xs p-1 rounded cursor-pointer transition-all",
                        "hover:shadow-md",
                        task.isCompleted ? 'bg-muted line-through opacity-60' : getPriorityColor(task.priorityLevel),
                        draggedTask?.id === task.id && 'opacity-50'
                      )}
                    >
                      <div className="flex items-start gap-1">
                        {canReschedule && <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-100 flex-shrink-0 mt-0.5" />}
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-medium">
                            {task.description.substring(0, 30)}
                            {task.description.length > 30 && '...'}
                          </div>
                          {viewMode === 'week' && (
                            <div className="flex items-center gap-1 mt-0.5 opacity-80">
                              <Clock className="h-2.5 w-2.5" />
                              <span>{task.startTime} - {task.endTime}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {viewMode === 'month' && dayTasks.length > 3 && (
                    <div className="text-[10px] text-muted-foreground text-center">
                      +{dayTasks.length - 3} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-red-500" />
            <span>Critical</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-orange-500" />
            <span>Urgent</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-yellow-500" />
            <span>High</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-blue-500" />
            <span>Normal</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-muted" />
            <span>Completed</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
