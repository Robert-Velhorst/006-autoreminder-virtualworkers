'use client';

import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Search, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { trpc } from '@/lib/trpc';

interface Task {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
  listId: string;
  url: string;
  due?: string;
  labels?: any[];
}

interface TaskSelectorProps {
  onTaskSelect: (taskId: string) => void;
  selectedTaskId?: string;
}

export function TaskSelector({ onTaskSelect, selectedTaskId }: TaskSelectorProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Fetch all tasks from Trello
  const { data: tasksData, isLoading: isLoadingTasks } = trpc.atis.getTasks.useQuery(
    undefined,
    {
      enabled: isOpen, // Only fetch when dropdown is opened
      staleTime: 5 * 60 * 1000, // 5 minutes
    }
  );

  // Update tasks list when data is fetched
  useEffect(() => {
    if (tasksData?.success && tasksData.tasks) {
      setTasks(tasksData.tasks);
      setError(null);
    } else if (tasksData?.error) {
      setError(tasksData.error);
      setTasks([]);
    }
  }, [tasksData]);

  // All open cards are loaded once per picker session. Filtering locally avoids
  // re-enumerating every Trello board on each keystroke.
  const filteredTasks = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return tasks;
    return tasks.filter((task) =>
      task.name.toLowerCase().includes(normalizedQuery)
      || task.boardName.toLowerCase().includes(normalizedQuery),
    );
  }, [tasks, searchQuery]);

  // Handle search input change
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    setError(null);
  };

  // Get selected task name
  const selectedTask = tasks.find(t => t.id === selectedTaskId);

  return (
    <div className="space-y-3">
      <label className="text-sm font-medium mb-2 block">Select Task from Trello</label>

      {/* Task Selector Button/Dropdown */}
      <div className="relative">
        <Button
          variant="outline"
          className="w-full justify-between text-left font-normal"
          onClick={() => setIsOpen(!isOpen)}
        >
          <span className="truncate">
            {selectedTask ? (
              <span>
                <span className="text-muted-foreground">{selectedTask.boardName} / </span>
                {selectedTask.name}
              </span>
            ) : (
              <span className="text-muted-foreground">Choose a task...</span>
            )}
          </span>
          <span className="ml-2">▼</span>
        </Button>

        {/* Dropdown Menu */}
        {isOpen && (
          <Card className="absolute top-full left-0 right-0 mt-2 z-50 shadow-lg">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Find Task</CardTitle>
              <CardDescription className="text-xs">Search your Trello boards</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Search Input */}
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search tasks..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-9"
                  autoFocus
                />
              </div>

              {/* Error Alert */}
              {error && (
                <Alert variant="destructive" className="py-2">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">{error}</AlertDescription>
                </Alert>
              )}

              {/* Loading State */}
              {isLoadingTasks && (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mr-2" />
                  <span className="text-sm text-muted-foreground">Loading tasks...</span>
                </div>
              )}

              {/* Task List */}
              {!isLoadingTasks && filteredTasks.length > 0 && (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {filteredTasks.map((task) => (
                    <button
                      key={task.id}
                      onClick={() => {
                        onTaskSelect(task.id);
                        setIsOpen(false);
                        setSearchQuery('');
                      }}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                        selectedTaskId === task.id
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-secondary text-foreground'
                      }`}
                    >
                      <div className="font-medium truncate">{task.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {task.boardName}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Empty State */}
              {!isLoadingTasks && filteredTasks.length === 0 && (
                <div className="text-center py-6">
                  <p className="text-sm text-muted-foreground">
                    {searchQuery ? 'No tasks found matching your search' : 'No tasks available'}
                  </p>
                </div>
              )}

              {/* Close Button */}
              <Button
                variant="ghost"
                className="w-full text-xs"
                onClick={() => setIsOpen(false)}
              >
                Close
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Manual Input Fallback */}
      <div className="text-xs text-muted-foreground pt-2 border-t">
        <p className="mb-2">Or enter task ID manually:</p>
        <Input
          type="text"
          placeholder="Paste task ID here..."
          value={selectedTaskId || ''}
          onChange={(e) => onTaskSelect(e.target.value)}
          className="text-xs"
        />
      </div>
    </div>
  );
}
