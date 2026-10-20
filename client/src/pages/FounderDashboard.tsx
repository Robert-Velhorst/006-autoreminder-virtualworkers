import { useState, useEffect, useMemo } from 'react';
import { Link } from 'wouter';
import { 
  ArrowLeft, Plus, Users, Clock, CheckCircle, AlertTriangle, Loader2, 
  MoreVertical, Mail, Globe, DollarSign, Search, Flag, ExternalLink,
  Star, MessageSquare, Calendar, Send, RefreshCw, Filter, Briefcase,
  Timer, AlertCircle, CheckSquare, XCircle, ArrowUpCircle,
  ChevronDown, ChevronRight, Sparkles, Target, ListChecks, Brain
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { TimezoneDisplay } from '@/components/TimezoneDisplay';
import DependencyGraph from '@/components/DependencyGraph';
import { ReanalysisProgressModal } from '@/components/ReanalysisProgressModal';
import { LabelAutocompleteSearch } from '@/components/LabelAutocompleteSearch';
import TIMEZONES from '@/data/timezones';
import CURRENCIES from '@/data/currencies';
import WeeklyPayCalculator from './manus/WeeklyPayCalculator';
import AptlssManagerReview from '@/components/AptlssManagerReview';

interface VirtualWorker {
  id: number;
  name: string;
  email: string | null;
  timezone: string;
  skills: string | null;
  hourlyRate: number | null;
  currency: string | null;
  workStartHour: number;
  workEndHour: number;
  workingDays: string;
  breakfastTime: number | null;
  breakfastDuration: number | null;
  lunchTime: number | null;
  lunchDuration: number | null;
  dinnerTime: number | null;
  dinnerDuration: number | null;
  status: 'active' | 'inactive' | 'on_leave';
  userId: number | null;
  linkedUserEmail: string | null;
  trelloMemberId: string | null;
}

interface SystemUser {
  id: number;
  name: string;
  email: string;
}

interface WorkloadItem {
  worker: VirtualWorker;
  totalTasks: number;
  statusCounts: {
    assigned: number;
    in_progress: number;
    completed: number;
    blocked: number;
  };
}

interface TaskAssignment {
  id: number;
  taskId: string;
  taskTitle: string;
  cardName: string;
  cardId: string;
  workerId: number | null;
  workerName: string | null;
  priority: 'critical' | 'urgent' | 'high' | 'normal';
  isPriorityOverride: boolean;
  status: 'assigned' | 'in_progress' | 'completed' | 'blocked';
  estimatedMinutes: number;
  scheduledStart?: string;
  scheduledEnd?: string;
  blockedBy: string[];
  blocks: string[];
  clientProject?: string;
  clientName?: string;
  clientPriority?: 'standard' | 'priority' | 'vip';
  labels: string[];
  description?: string | null;
  goal?: string | null;
  deliverable?: string | null;
  checklist?: Array<{ step: string; timeMinutes: number; aptlssType: string }> | null;
}


interface CommunicationEntry {
  id: number;
  taskId: string;
  workerId: number;
  workerName: string;
  type: 'note' | 'question' | 'update' | 'handoff';
  message: string;
  timestamp: string;
  isRead: boolean;
}

interface TimezoneOverlap {
  workerId: number;
  workerName: string;
  workerTimezone: string;
  overlapHours: number;
  overlapStart: string;
  overlapEnd: string;
}

export default function FounderDashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [workload, setWorkload] = useState<WorkloadItem[]>([]);
  const [assignments, setAssignments] = useState<TaskAssignment[]>([]);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  const toggleTaskExpanded = (taskId: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const [communications, setCommunications] = useState<CommunicationEntry[]>([]);
  const [timezoneOverlaps, setTimezoneOverlaps] = useState<TimezoneOverlap[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [newWorker, setNewWorker] = useState({
    name: '',
    email: '',
    password: '',
    timezone: 'Asia/Manila',
    hourlyRate: '',
    currency: 'USD',
    workStartHour: '9',
    workEndHour: '18',
    workingDays: '1,2,3,4,5',
    breakfastTime: '7',
    breakfastDuration: '30',
    lunchTime: '12',
    lunchDuration: '60',
    dinnerTime: '19',
    dinnerDuration: '45',
    trelloMemberId: '',
  });
  const [showEditWorker, setShowEditWorker] = useState(false);
  const [editingWorker, setEditingWorker] = useState<VirtualWorker | null>(null);
  const [editWorkerPassword, setEditWorkerPassword] = useState('');
  const [saving, setSaving] = useState(false);
  
  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedWorkerFilter, setSelectedWorkerFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  
  // Briefing settings
  const [briefingEnabled, setBriefingEnabled] = useState(true);
  const [briefingTime, setBriefingTime] = useState('08:00');
  const [eodReportEnabled, setEodReportEnabled] = useState(true);
  const [eodReportTime, setEodReportTime] = useState('18:00');
  

  
  // Re-analysis state
  const [isReanalyzing, setIsReanalyzing] = useState(false);
  const [reanalysisProgress, setReanalysisProgress] = useState<{ total: number; processed: number; failed: number } | null>(null);
  const [showReanalysisModal, setShowReanalysisModal] = useState(false);
  const [selectedBoardForReanalysis, setSelectedBoardForReanalysis] = useState<{ id: string; name: string } | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null);

  // Set default worker once workload is loaded
  useEffect(() => {
    if (workload.length > 0 && selectedWorkerId === null) {
      const firstActiveWorker = workload.find(w => w.worker.userId !== null);
      if (firstActiveWorker && firstActiveWorker.worker.userId) {
        setSelectedWorkerId(firstActiveWorker.worker.userId);
      } else {
        setSelectedWorkerId(workload[0].worker.id);
      }
    }
  }, [workload, selectedWorkerId]);

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      await Promise.all([
        fetchWorkload(),
        fetchAssignments(),

        fetchCommunications(),
        fetchTimezoneOverlaps(),
        fetchBriefingSettings(),
      ]);
    } finally {
      setLoading(false);
    }
  };

  const fetchWorkload = async () => {
    try {
      const res = await fetch('/api/va/workload-overview', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setWorkload(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      console.error('Error fetching workload:', error);
    }
  };

  const fetchAssignments = async () => {
    try {
      const res = await fetch('/api/va/assignments', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setAssignments(Array.isArray(data) ? data : data.assignments || []);
      }
    } catch (error) {
      console.error('Error fetching assignments:', error);
    }
  };


  const fetchCommunications = async () => {
    try {
      const res = await fetch('/api/va/communications', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCommunications(Array.isArray(data) ? data : data.communications || []);
      }
    } catch (error) {
      console.error('Error fetching communications:', error);
    }
  };

  const fetchTimezoneOverlaps = async () => {
    try {
      const res = await fetch('/api/va/timezone-overlaps', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTimezoneOverlaps(Array.isArray(data) ? data : data.overlaps || []);
      }
    } catch (error) {
      console.error('Error fetching timezone overlaps:', error);
    }
  };

  const fetchBriefingSettings = async () => {
    try {
      const res = await fetch('/api/va/briefing-settings', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data) {
          setBriefingEnabled(data.morningBriefingEnabled ?? true);
          setBriefingTime(data.morningBriefingTime ?? '08:00');
          setEodReportEnabled(data.eodReportEnabled ?? true);
          setEodReportTime(data.eodReportTime ?? '18:00');
        }
      }
    } catch (error) {
      console.error('Error fetching briefing settings:', error);
    }
  };

  const handleAddWorker = async () => {
    if (!newWorker.name.trim()) {
      toast.error('Please enter a name');
      return;
    }
    if (!newWorker.email.trim()) {
      toast.error('Please enter an email');
      return;
    }
    if (!newWorker.password.trim()) {
      toast.error('Please enter a password');
      return;
    }
    if (newWorker.password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/va/vas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: newWorker.name,
          email: newWorker.email,
          password: newWorker.password,
          timezone: newWorker.timezone,
          hourlyRate: newWorker.hourlyRate ? parseInt(newWorker.hourlyRate) * 100 : null,
          currency: newWorker.currency,
          workStartHour: parseInt(newWorker.workStartHour),
          workEndHour: parseInt(newWorker.workEndHour),
          workingDays: newWorker.workingDays,
          breakfastTime: parseInt(newWorker.breakfastTime),
          breakfastDuration: parseInt(newWorker.breakfastDuration),
          lunchTime: parseInt(newWorker.lunchTime),
          lunchDuration: parseInt(newWorker.lunchDuration),
          dinnerTime: parseInt(newWorker.dinnerTime),
          dinnerDuration: parseInt(newWorker.dinnerDuration),
          trelloMemberId: newWorker.trelloMemberId || null,
        }),
      });

      if (res.ok) {
        toast.success('Worker added successfully');
        setShowAddWorker(false);
        setNewWorker({ name: '', email: '', password: '', timezone: 'Asia/Manila', hourlyRate: '', currency: 'USD', workStartHour: '9', workEndHour: '18', workingDays: '1,2,3,4,5', breakfastTime: '7', breakfastDuration: '30', lunchTime: '12', lunchDuration: '60', dinnerTime: '19', dinnerDuration: '45', trelloMemberId: '' });
        fetchWorkload();
      } else {
        const err = await res.json();
        toast.error('Failed to add worker', { description: err.error });
      }
    } catch (error) {
      toast.error('Failed to add worker');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateStatus = async (workerId: number, status: string) => {
    try {
      const res = await fetch(`/api/va/vas/${workerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status }),
      });

      if (res.ok) {
        toast.success('Status updated');
        fetchWorkload();
      }
    } catch (error) {
      toast.error('Failed to update status');
    }
  };

  const handleAssignTask = async (taskId: string, workerId: number) => {
    try {
      const res = await fetch(`/api/va/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ taskId, vaId: workerId }),
      });

      if (res.ok) {
        const worker = workload.find(w => w.worker.id === workerId)?.worker;
        setAssignments(assignments.map(a => 
          a.taskId === taskId 
            ? { ...a, workerId, workerName: worker?.name || null, status: 'assigned' }
            : a
        ));
        toast.success(`Task assigned to ${worker?.name}`);
        fetchWorkload();
      } else {
        toast.error('Failed to assign task');
      }
    } catch (error) {
      toast.error('Failed to assign task');
    }
  };

  const handlePriorityOverride = async (taskId: string, priority: string) => {
    try {
      const res = await fetch(`/api/va/priority-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ taskId, priority }),
      });

      if (res.ok) {
        setAssignments(assignments.map(a => 
          a.taskId === taskId 
            ? { ...a, priority: priority as any, isPriorityOverride: true }
            : a
        ));
        toast.success(`Priority set to ${priority.toUpperCase()}`);
      } else {
        toast.error('Failed to set priority');
      }
    } catch (error) {
      toast.error('Failed to set priority');
    }
  };



  const handleSaveBriefingSettings = async () => {
    try {
      const res = await fetch('/api/va/briefing-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          morningBriefingEnabled: briefingEnabled,
          morningBriefingTime: briefingTime,
          eodReportEnabled: eodReportEnabled,
          eodReportTime: eodReportTime,
        }),
      });

      if (res.ok) {
        toast.success('Briefing settings saved');
      } else {
        toast.error('Failed to save settings');
      }
    } catch (error) {
      toast.error('Failed to save settings');
    }
  };

  const handleSaveWorkerSettings = async () => {
    if (!editingWorker) return;
    
    if (editWorkerPassword && editWorkerPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/va/vas/${editingWorker.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: editingWorker.name,
          email: editingWorker.email,
          password: editWorkerPassword || undefined,
          timezone: editingWorker.timezone,
          hourlyRate: editingWorker.hourlyRate,
          currency: editingWorker.currency,
          workStartHour: editingWorker.workStartHour,
          workEndHour: editingWorker.workEndHour,
          workingDays: editingWorker.workingDays,
          breakfastTime: editingWorker.breakfastTime,
          breakfastDuration: editingWorker.breakfastDuration,
          lunchTime: editingWorker.lunchTime,
          lunchDuration: editingWorker.lunchDuration,
          dinnerTime: editingWorker.dinnerTime,
          dinnerDuration: editingWorker.dinnerDuration,
          trelloMemberId: editingWorker.trelloMemberId || null,
        }),
      });

      if (res.ok) {
        toast.success('Worker settings saved');
        setShowEditWorker(false);
        setEditingWorker(null);
        setEditWorkerPassword('');
        fetchWorkload();
      } else {
        const err = await res.json();
        toast.error('Failed to save settings', { description: err.error });
      }
    } catch (error) {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // Re-analyze all cards with AI
  const handleReanalyzeAll = async () => {
    setIsReanalyzing(true);
    setReanalysisProgress(null);
    
    try {
      toast.info('Starting AI re-analysis of all cards...', {
        description: 'This may take several minutes. Progress will be shown below.',
        duration: 5000,
      });
      
      const res = await fetch('/api/atis/understanding/reanalyze-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ forceAll: true, limit: 200 }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setReanalysisProgress({
          total: data.total,
          processed: data.processed,
          failed: data.failed,
        });
        toast.success(`Re-analysis complete!`, {
          description: `Processed ${data.processed} cards, ${data.failed} failed`,
          duration: 10000,
        });
      } else {
        const error = await res.json();
        toast.error('Re-analysis failed', { description: error.error });
      }
    } catch (error) {
      toast.error('Failed to start re-analysis');
    } finally {
      setIsReanalyzing(false);
    }
  };

  // Extract all unique labels from assignments
  const allLabels = useMemo(() => {
    const labels = new Set<string>();
    assignments.forEach(a => {
      a.labels.forEach(label => labels.add(label));
    });
    return Array.from(labels).sort();
  }, [assignments]);

  // Filter assignments
  const filteredAssignments = useMemo(() => {
    let filtered = assignments;
    
    if (selectedWorkerFilter !== 'all') {
      filtered = filtered.filter(a => a.workerId === parseInt(selectedWorkerFilter));
    }
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(a => 
        a.taskTitle.toLowerCase().includes(query) ||
        a.cardName.toLowerCase().includes(query) ||
        a.clientProject?.toLowerCase().includes(query) ||
        a.labels.some(label => label.toLowerCase().includes(query))
      );
    }
    
    if (priorityFilter !== 'all') {
      filtered = filtered.filter(a => a.priority === priorityFilter);
    }
    
    return filtered;
  }, [assignments, selectedWorkerFilter, searchQuery, priorityFilter]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-500/10 text-green-500';
      case 'inactive': return 'bg-gray-500/10 text-gray-500';
      case 'on_leave': return 'bg-yellow-500/10 text-yellow-500';
      default: return 'bg-gray-500/10 text-gray-500';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical': return 'bg-red-500 text-white';
      case 'urgent': return 'bg-orange-500 text-white';
      case 'high': return 'bg-yellow-500 text-black';
      default: return 'bg-gray-200 text-gray-700';
    }
  };

  const getTaskStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-100 text-green-700"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
      case 'in_progress':
        return <Badge className="bg-blue-100 text-blue-700"><Timer className="h-3 w-3 mr-1" />In Progress</Badge>;
      case 'blocked':
        return <Badge className="bg-red-100 text-red-700"><AlertCircle className="h-3 w-3 mr-1" />Blocked</Badge>;
      default:
        return <Badge className="bg-gray-100 text-gray-700"><Clock className="h-3 w-3 mr-1" />Assigned</Badge>;
    }
  };

  const getWorkloadLevel = (item: WorkloadItem) => {
    const active = item.statusCounts.assigned + item.statusCounts.in_progress;
    if (active > 10) return { level: 'Overloaded', color: 'text-red-500' };
    if (active > 5) return { level: 'High', color: 'text-yellow-500' };
    if (active > 0) return { level: 'Normal', color: 'text-green-500' };
    return { level: 'Available', color: 'text-blue-500' };
  };

  const totalStats = workload.reduce((acc, item) => ({
    totalTasks: acc.totalTasks + item.totalTasks,
    inProgress: acc.inProgress + item.statusCounts.in_progress,
    completed: acc.completed + item.statusCounts.completed,
    blocked: acc.blocked + item.statusCounts.blocked,
  }), { totalTasks: 0, inProgress: 0, completed: 0, blocked: 0 });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex min-h-16 flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                Virtual Worker Management
              </h1>
              <p className="text-sm text-muted-foreground">Manage your virtual workers and workload</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchAllData}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => {
                setSelectedBoardForReanalysis(null);
                setShowReanalysisModal(true);
              }}
            >
              <ArrowUpCircle className="h-4 w-4 mr-2" />
              Re-analyze All
            </Button>
            <Dialog open={showAddWorker} onOpenChange={setShowAddWorker}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Worker
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Virtual Worker</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Name *</Label>
                    <Input
                      value={newWorker.name}
                      onChange={(e) => setNewWorker({ ...newWorker, name: e.target.value })}
                      placeholder="e.g., Worker"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Email *</Label>
                    <Input
                      type="email"
                      value={newWorker.email}
                      onChange={(e) => setNewWorker({ ...newWorker, email: e.target.value })}
                      placeholder="va@example.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Password *</Label>
                    <Input
                      type="password"
                      value={newWorker.password}
                      onChange={(e) => setNewWorker({ ...newWorker, password: e.target.value })}
                      placeholder="Min 6 characters"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Trello Member ID</Label>
                    <Input
                      value={newWorker.trelloMemberId || ''}
                      onChange={(e) => setNewWorker({ ...newWorker, trelloMemberId: e.target.value })}
                      placeholder="e.g., 664ed797b37eb4605ed64bc1"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Timezone</Label>
                    <Select value={newWorker.timezone} onValueChange={(v) => setNewWorker({ ...newWorker, timezone: v })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONES.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Hourly Rate</Label>
                      <Input
                        type="number"
                        value={newWorker.hourlyRate}
                        onChange={(e) => setNewWorker({ ...newWorker, hourlyRate: e.target.value })}
                        placeholder="15"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Currency</Label>
                      <Select value={newWorker.currency} onValueChange={(v) => setNewWorker({ ...newWorker, currency: v })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CURRENCIES.map((c) => (
                            <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Working Hours Section */}
                  <div className="border-t pt-4 mt-4">
                    <h4 className="font-medium mb-3 flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Working Hours
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Start Time</Label>
                        <Select value={newWorker.workStartHour} onValueChange={(v) => setNewWorker({ ...newWorker, workStartHour: v })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({ length: 24 }, (_, i) => (
                              <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>End Time</Label>
                        <Select value={newWorker.workEndHour} onValueChange={(v) => setNewWorker({ ...newWorker, workEndHour: v })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({ length: 24 }, (_, i) => (
                              <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    
                    {/* Working Days */}
                    <div className="mt-4">
                      <Label className="mb-2 block">Working Days</Label>
                      <div className="flex flex-wrap gap-2">
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => {
                          const days = newWorker.workingDays.split(',').filter(d => d).map(d => parseInt(d));
                          const isSelected = days.includes(index);
                          return (
                            <Button
                              key={day}
                              type="button"
                              variant={isSelected ? 'default' : 'outline'}
                              size="sm"
                              onClick={() => {
                                const newDays = isSelected
                                  ? days.filter(d => d !== index)
                                  : [...days, index].sort();
                                setNewWorker({ ...newWorker, workingDays: newDays.join(',') });
                              }}
                            >
                              {day}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Meal Times Section */}
                  <div className="border-t pt-4 mt-4">
                    <h4 className="font-medium mb-3 flex items-center gap-2">
                      <Briefcase className="h-4 w-4" />
                      Meal Breaks
                    </h4>
                    
                    {/* Breakfast */}
                    <div className="mb-4">
                      <Label className="text-sm text-muted-foreground mb-2 block">Breakfast</Label>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Time</Label>
                          <Select value={newWorker.breakfastTime} onValueChange={(v) => setNewWorker({ ...newWorker, breakfastTime: v })}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 24 }, (_, i) => (
                                <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Duration</Label>
                          <Select value={newWorker.breakfastDuration} onValueChange={(v) => setNewWorker({ ...newWorker, breakfastDuration: v })}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="15">15 min</SelectItem>
                              <SelectItem value="30">30 min</SelectItem>
                              <SelectItem value="45">45 min</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>

                    {/* Lunch */}
                    <div className="mb-4">
                      <Label className="text-sm text-muted-foreground mb-2 block">Lunch</Label>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Time</Label>
                          <Select value={newWorker.lunchTime} onValueChange={(v) => setNewWorker({ ...newWorker, lunchTime: v })}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 24 }, (_, i) => (
                                <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Duration</Label>
                          <Select value={newWorker.lunchDuration} onValueChange={(v) => setNewWorker({ ...newWorker, lunchDuration: v })}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="30">30 min</SelectItem>
                              <SelectItem value="45">45 min</SelectItem>
                              <SelectItem value="60">1 hour</SelectItem>
                              <SelectItem value="90">1.5 hours</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>

                    {/* Dinner */}
                    <div>
                      <Label className="text-sm text-muted-foreground mb-2 block">Dinner</Label>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Time</Label>
                          <Select value={newWorker.dinnerTime} onValueChange={(v) => setNewWorker({ ...newWorker, dinnerTime: v })}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 24 }, (_, i) => (
                                <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Duration</Label>
                          <Select value={newWorker.dinnerDuration} onValueChange={(v) => setNewWorker({ ...newWorker, dinnerDuration: v })}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="30">30 min</SelectItem>
                              <SelectItem value="45">45 min</SelectItem>
                              <SelectItem value="60">1 hour</SelectItem>
                              <SelectItem value="90">1.5 hours</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowAddWorker(false)}>Cancel</Button>
                  <Button onClick={handleAddWorker} disabled={saving}>
                    {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Add Worker
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      <main className="container py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 md:grid-cols-4 xl:grid-cols-8">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="assignments">Assignments</TabsTrigger>
            <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
            <TabsTrigger value="communications">Communications</TabsTrigger>
            <TabsTrigger value="timezones">Timezones</TabsTrigger>
            <TabsTrigger value="briefings">Briefings</TabsTrigger>
            <TabsTrigger value="paylogs">Pay Logs</TabsTrigger>
            <TabsTrigger value="manager-review">Manager review</TabsTrigger>
          </TabsList>

          <TabsContent value="manager-review"><AptlssManagerReview /></TabsContent>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            {/* Overview Stats */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Total Workers</span>
                  </div>
                  <p className="text-2xl font-bold mt-1">{workload.length}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-blue-500" />
                    <span className="text-sm text-muted-foreground">In Progress</span>
                  </div>
                  <p className="text-2xl font-bold mt-1">{totalStats.inProgress}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span className="text-sm text-muted-foreground">Completed</span>
                  </div>
                  <p className="text-2xl font-bold mt-1">{totalStats.completed}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-500" />
                    <span className="text-sm text-muted-foreground">Blocked</span>
                  </div>
                  <p className="text-2xl font-bold mt-1">{totalStats.blocked}</p>
                </CardContent>
              </Card>
            </div>

            {/* VA Cards */}
            {loading ? (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {Array(3).fill(0).map((_, i) => (
                  <Card key={i}>
                    <CardHeader>
                      <Skeleton className="h-10 w-10 rounded-full" />
                      <Skeleton className="h-4 w-32 mt-2" />
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-4 w-full mb-2" />
                      <Skeleton className="h-4 w-3/4" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : workload.length === 0 ? (
              <Card className="py-12">
                <CardContent className="text-center">
                  <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Virtual Workers Yet</h3>
                  <p className="text-muted-foreground mb-4">Add your first virtual worker to start managing tasks and workload.</p>
                  <Button onClick={() => setShowAddWorker(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Your First Worker
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {workload.map((item) => {
                  const workloadLevel = getWorkloadLevel(item);
                  const skills = item.worker.skills ? JSON.parse(item.worker.skills) : [];
                  
                  return (
                    <Card key={item.worker.id} className="relative hover:shadow-md transition-shadow">
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                              <span className="text-lg font-semibold text-primary">
                                {item.worker.name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <div>
                              <CardTitle className="text-lg">{item.worker.name}</CardTitle>
                              <Badge className={getStatusColor(item.worker.status)}>
                                {item.worker.status.replace('_', ' ')}
                              </Badge>
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => {
                                setEditingWorker(item.worker);
                                setShowEditWorker(true);
                              }}>
                                Edit Settings
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => {
                                setSelectedWorkerFilter(item.worker.id.toString());
                                setActiveTab('assignments');
                              }}>
                                View Tasks
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => handleUpdateStatus(item.worker.id, 'active')}>
                                Set Active
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleUpdateStatus(item.worker.id, 'on_leave')}>
                                Set On Leave
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleUpdateStatus(item.worker.id, 'inactive')}>
                                Set Inactive
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {/* Contact & Location */}
                        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                          {item.worker.email && (
                            <div className="flex items-center gap-1">
                              <Mail className="h-3 w-3" />
                              <span className="truncate max-w-[150px]">{item.worker.email}</span>
                            </div>
                          )}
                          <TimezoneDisplay
                            workerId={item.worker.id}
                            currentTimezone={item.worker.timezone}
                            compact
                            onTimezoneChange={() => fetchWorkload()}
                          />
                          {item.worker.hourlyRate && (
                            <div className="flex items-center gap-1">
                              <DollarSign className="h-3 w-3" />
                              <span>{(item.worker.hourlyRate / 100).toFixed(0)}/hr</span>
                            </div>
                          )}
                          {item.worker.userId && (
                            <div className="flex items-center gap-1">
                              <Users className="h-3 w-3 text-green-500" />
                              <span className="text-green-600 font-medium">Login Active</span>
                            </div>
                          )}
                        </div>

                        {/* Workload Bar */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">Workload</span>
                            <span className={`text-sm font-medium ${workloadLevel.color}`}>
                              {workloadLevel.level}
                            </span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-primary transition-all"
                              style={{ width: `${Math.min((item.statusCounts.assigned + item.statusCounts.in_progress) * 10, 100)}%` }}
                            />
                          </div>
                        </div>

                        {/* Task Stats */}
                        <div className="grid grid-cols-4 gap-2 text-center">
                          <div className="p-2 bg-muted/50 rounded">
                            <p className="text-lg font-semibold">{item.statusCounts.assigned}</p>
                            <p className="text-xs text-muted-foreground">Assigned</p>
                          </div>
                          <div className="p-2 bg-blue-500/10 rounded">
                            <p className="text-lg font-semibold text-blue-500">{item.statusCounts.in_progress}</p>
                            <p className="text-xs text-muted-foreground">Active</p>
                          </div>
                          <div className="p-2 bg-green-500/10 rounded">
                            <p className="text-lg font-semibold text-green-500">{item.statusCounts.completed}</p>
                            <p className="text-xs text-muted-foreground">Done</p>
                          </div>
                          <div className="p-2 bg-red-500/10 rounded">
                            <p className="text-lg font-semibold text-red-500">{item.statusCounts.blocked}</p>
                            <p className="text-xs text-muted-foreground">Blocked</p>
                          </div>
                        </div>

                        {/* Skills */}
                        {skills.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {skills.slice(0, 3).map((skill: string) => (
                              <Badge key={skill} variant="outline" className="text-xs">
                                {skill}
                              </Badge>
                            ))}
                            {skills.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{skills.length - 3}
                              </Badge>
                            )}
                          </div>
                        )}

                        {/* Working Hours */}
                        <div className="text-xs text-muted-foreground">
                          Working: {item.worker.workStartHour}:00 - {item.worker.workEndHour}:00 ({item.worker.timezone.split('/')[1]?.replace('_', ' ')})
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Load Balancing Suggestion */}
            {workload.some(w => getWorkloadLevel(w).level === 'Overloaded') && (
              <Card className="border-yellow-500/50 bg-yellow-500/5">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-yellow-500">
                    <AlertTriangle className="h-5 w-5" />
                    Load Balancing Suggestion
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    Some workers are overloaded. Consider redistributing tasks to workers with lower workload
                    or hiring additional help.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setActiveTab('assignments')}>View Task Distribution</Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Assignments Tab */}
          <TabsContent value="assignments" className="space-y-6">
            {/* Filters */}
            <div className="flex flex-col md:flex-row gap-4">
              <LabelAutocompleteSearch
                value={searchQuery}
                onChange={setSearchQuery}
                allLabels={allLabels}
                placeholder="Search tasks or labels..."
              />
              <Select value={selectedWorkerFilter} onValueChange={setSelectedWorkerFilter}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Filter by Worker" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Workers</SelectItem>
                  {workload.map(w => (
                    <SelectItem key={w.worker.id} value={w.worker.id.toString()}>{w.worker.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Priorities</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Task List */}
            <div className="space-y-3">
              {loading ? (
                Array(5).fill(0).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))
              ) : filteredAssignments.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    <CheckSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No tasks found matching your filters.</p>
                    <p className="text-sm mt-2">Tasks from Trello will appear here once synced.</p>
                  </CardContent>
                </Card>
              ) : (
                filteredAssignments.map(task => {
                  const isExpanded = expandedTasks.has(task.taskId);
                  const totalSteps = task.checklist?.length || 0;
                  const totalMinutes = task.checklist?.reduce((sum: number, item: any) => sum + (item.timeMinutes || 0), 0) || task.estimatedMinutes || 60;

                  return (
                    <Card key={task.id} className="hover:shadow-md transition-shadow">
                      <CardContent className="py-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <button 
                              className="mt-1 flex-shrink-0 focus:outline-none"
                              onClick={() => toggleTaskExpanded(task.taskId)}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-5 w-5 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-5 w-5 text-muted-foreground" />
                              )}
                            </button>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap cursor-pointer" onClick={() => toggleTaskExpanded(task.taskId)}>
                                <Badge className={getPriorityColor(task.priority)}>
                                  {task.priority.toUpperCase()}
                                </Badge>
                                {task.isPriorityOverride && (
                                  <Badge variant="outline" className="text-xs">
                                    <ArrowUpCircle className="h-3 w-3 mr-1" />
                                    Override
                                  </Badge>
                                )}
                                {getTaskStatusBadge(task.status)}
                              </div>
                              <h3 
                                className="font-medium cursor-pointer hover:underline text-base" 
                                onClick={() => toggleTaskExpanded(task.taskId)}
                              >
                                {task.taskTitle}
                              </h3>
                              <p className="text-sm text-muted-foreground flex items-center gap-2 mt-0.5">
                                <Briefcase className="h-3 w-3" />
                                {task.cardName}
                                {(task.clientProject || task.clientName) && (
                                  <>
                                    <span>•</span>
                                    {task.clientName || task.clientProject}
                                    {task.clientPriority && task.clientPriority !== 'standard' && (
                                      <Badge 
                                        variant="outline" 
                                        className={`text-xs ml-1 ${task.clientPriority === 'vip' ? 'bg-amber-100 text-amber-800 border-amber-300' : 'bg-blue-100 text-blue-800 border-blue-300'}`}
                                      >
                                        {task.clientPriority.toUpperCase()}
                                      </Badge>
                                    )}
                                  </>
                                )}
                              </p>
                              {task.blockedBy && task.blockedBy.length > 0 && (
                                <p className="text-sm text-red-500 flex items-center gap-1 mt-1">
                                  <AlertCircle className="h-3 w-3" />
                                  Blocked by: {task.blockedBy.join(', ')}
                                </p>
                              )}
                              {task.labels && task.labels.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {task.labels.map((label: string) => (
                                    <Badge key={label} variant="secondary" className="text-xs">
                                      {label}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {totalMinutes >= 60 ? `${(totalMinutes / 60).toFixed(1)}h` : `${totalMinutes}m`}
                                </span>
                                {totalSteps > 0 && (
                                  <span className="flex items-center gap-1">
                                    <ListChecks className="h-3.5 w-3.5" />
                                    {totalSteps} steps
                                  </span>
                                )}
                                {task.scheduledStart && (
                                  <span className="flex items-center gap-1">
                                    <Calendar className="h-3 w-3" />
                                    {task.scheduledStart} - {task.scheduledEnd}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-2 flex-shrink-0">
                            {/* VA Assignment */}
                            <Select
                              value={task.workerId?.toString() || 'unassigned'}
                              onValueChange={(v) => v !== 'unassigned' && handleAssignTask(task.taskId, parseInt(v))}
                            >
                              <SelectTrigger className="w-[160px]">
                                <SelectValue placeholder="Assign Worker" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="unassigned">Unassigned</SelectItem>
                                {workload.map(w => (
                                  <SelectItem key={w.worker.id} value={w.worker.id.toString()}>
                                    <span className="flex items-center gap-2">
                                      <span className={`h-2 w-2 rounded-full ${w.worker.status === 'active' ? 'bg-green-500' : w.worker.status === 'on_leave' ? 'bg-yellow-500' : 'bg-gray-400'}`} />
                                      {w.worker.name}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            
                            {/* Priority Override */}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="sm">
                                  <Flag className="h-4 w-4 mr-2" />
                                  Priority
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Set Priority</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => handlePriorityOverride(task.taskId, 'critical')}>
                                  <span className="h-2 w-2 rounded-full bg-red-500 mr-2" />
                                  Critical - Do This First!
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handlePriorityOverride(task.taskId, 'urgent')}>
                                  <span className="h-2 w-2 rounded-full bg-orange-500 mr-2" />
                                  Urgent
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handlePriorityOverride(task.taskId, 'high')}>
                                  <span className="h-2 w-2 rounded-full bg-yellow-500 mr-2" />
                                  High
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handlePriorityOverride(task.taskId, 'normal')}>
                                  <span className="h-2 w-2 rounded-full bg-gray-400 mr-2" />
                                  Normal
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            
                            {/* Open in Trello */}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => window.open(`https://trello.com/c/${task.cardId}`, '_blank')}
                            >
                              <ExternalLink className="h-4 w-4 mr-2" />
                              Trello
                            </Button>
                          </div>
                        </div>

                        {/* Expanded details container */}
                        {isExpanded && (
                          <div className="mt-4 pt-4 border-t space-y-4 pl-8">
                            {/* Card Description */}
                            {task.description && (
                              <div className="space-y-1">
                                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Description</h4>
                                <p className="text-sm text-foreground bg-muted/20 p-3 rounded-lg border leading-relaxed whitespace-pre-wrap">
                                  {task.description}
                                </p>
                              </div>
                            )}

                            {/* AI Goal & AI Deliverable */}
                            {(task.goal || task.deliverable) && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {task.goal && (
                                  <div className="bg-purple-50/50 p-3 rounded-lg border border-purple-100">
                                    <h4 className="text-xs font-semibold text-purple-800 flex items-center gap-1 mb-1">
                                      <Target className="h-3.5 w-3.5" />
                                      AI Goal
                                    </h4>
                                    <p className="text-xs text-purple-700 leading-relaxed">{task.goal}</p>
                                  </div>
                                )}
                                {task.deliverable && (
                                  <div className="bg-blue-50/50 p-3 rounded-lg border border-blue-100">
                                    <h4 className="text-xs font-semibold text-blue-800 flex items-center gap-1 mb-1">
                                      <Sparkles className="h-3.5 w-3.5" />
                                      AI Deliverable
                                    </h4>
                                    <p className="text-xs text-blue-700 leading-relaxed">{task.deliverable}</p>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* AI Checklist Steps */}
                            {task.checklist && task.checklist.length > 0 ? (
                              <div className="space-y-2">
                                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                                  <ListChecks className="h-3.5 w-3.5" />
                                  AI Checklist Breakdown
                                </h4>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[300px] overflow-y-auto pr-1">
                                  {task.checklist.map((step: any, index: number) => {
                                    const stepColors: Record<string, string> = {
                                      P: 'bg-purple-100 text-purple-700 border-purple-200',
                                      T: 'bg-green-100 text-green-700 border-green-200',
                                      A: 'bg-blue-100 text-blue-700 border-blue-200',
                                      L: 'bg-yellow-100 text-yellow-700 border-yellow-200',
                                      S: 'bg-orange-100 text-orange-700 border-orange-200',
                                    };
                                    const colorClass = stepColors[step.aptlssType] || 'bg-gray-100 text-gray-700';

                                    return (
                                      <div key={step.id} className="flex items-start gap-2.5 p-2.5 rounded-lg border bg-card text-xs hover:bg-muted/10 transition-colors shadow-sm">
                                        <div className="flex flex-col items-center gap-0.5">
                                          <span className="text-[10px] text-muted-foreground font-semibold">#{index + 1}</span>
                                          <Badge variant="outline" className={`px-1 py-0 text-[10px] border-none scale-90 ${colorClass}`}>
                                            {step.aptlssType}
                                          </Badge>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="font-medium text-foreground leading-snug" title={step.step}>
                                            {step.step}
                                          </p>
                                          <span className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1">
                                            <Clock className="h-2.5 w-2.5" />
                                            {step.timeMinutes}m
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : (
                              <div className="text-xs text-muted-foreground flex items-center gap-1.5 py-1">
                                <Brain className="h-4 w-4 animate-pulse text-purple-400" />
                                <span>No detailed checklist available for this card yet.</span>
                              </div>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </TabsContent>

          {/* Dependencies Tab */}
          <TabsContent value="dependencies" className="space-y-6">
            <DependencyGraph
              tasks={assignments.map(a => ({
                id: a.id.toString(),
                title: a.taskTitle,
                cardName: a.cardName,
                status: a.status as 'assigned' | 'in_progress' | 'completed' | 'blocked',
                blockedBy: a.blockedBy || [],
                blocks: a.blocks || [],
              }))}
              onRefresh={fetchAssignments}
            />
          </TabsContent>

          {/* Communications Tab */}
          <TabsContent value="communications" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-blue-500" />
                  Communication Log
                </CardTitle>
                <CardDescription>Messages, notes, and handoffs from workers</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="space-y-3">
                    {Array(3).fill(0).map((_, i) => (
                      <Skeleton key={i} className="h-20 w-full" />
                    ))}
                  </div>
                ) : communications.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No communications yet</p>
                    <p className="text-sm mt-2">VA notes and handoff messages will appear here.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {communications.map(comm => (
                      <div key={comm.id} className={`border rounded-lg p-4 ${!comm.isRead ? 'bg-blue-50 border-blue-200' : ''}`}>
                        <div className="flex items-start gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback>{comm.workerName.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium">{comm.workerName}</span>
                              <Badge variant="outline" className="text-xs">{comm.type}</Badge>
                              <span className="text-xs text-muted-foreground">
                                {new Date(comm.timestamp).toLocaleString()}
                              </span>
                            </div>
                            <p className="mt-1">{comm.message}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Timezones Tab */}
          <TabsContent value="timezones" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="h-5 w-5 text-green-500" />
                  Timezone Overlap Calculator
                </CardTitle>
                <CardDescription>See working hour overlaps with your workers</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="space-y-3">
                    {Array(3).fill(0).map((_, i) => (
                      <Skeleton key={i} className="h-16 w-full" />
                    ))}
                  </div>
                ) : workload.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No workers configured to calculate timezone overlaps</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {workload.map(w => {
                      // Calculate overlap (simplified - assumes founder is in Europe/Amsterdam)
                      const founderStart = 9;
                      const founderEnd = 18;
                      const vaStart = w.worker.workStartHour;
                      const vaEnd = w.worker.workEndHour;
                      
                      // Simple timezone offset calculation (approximate)
                      const tzOffsets: Record<string, number> = {
                        'Europe/Amsterdam': 1,
                        'Asia/Manila': 8,
                        'Asia/Jakarta': 7,
                        'Asia/Kolkata': 5.5,
                        'America/New_York': -5,
                        'America/Los_Angeles': -8,
                        'UTC': 0,
                      };
                      
                      const founderOffset = tzOffsets['Europe/Amsterdam'] || 0;
                      const vaOffset = tzOffsets[w.worker.timezone] || 0;
                      const diff = vaOffset - founderOffset;
                      
                      // Convert VA hours to founder's timezone
                      const vaStartInFounder = vaStart - diff;
                      const vaEndInFounder = vaEnd - diff;
                      
                      // Calculate overlap
                      const overlapStart = Math.max(founderStart, vaStartInFounder);
                      const overlapEnd = Math.min(founderEnd, vaEndInFounder);
                      const overlapHours = Math.max(0, overlapEnd - overlapStart);
                      
                      return (
                        <div key={w.worker.id} className="border rounded-lg p-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <h3 className="font-medium">{w.worker.name}</h3>
                              <p className="text-sm text-muted-foreground">{w.worker.timezone}</p>
                              <p className="text-xs text-muted-foreground">
                                Works {w.worker.workStartHour}:00 - {w.worker.workEndHour}:00 local time
                              </p>
                            </div>
                            <div className="text-right">
                              <div className={`text-2xl font-bold ${overlapHours >= 4 ? 'text-green-600' : overlapHours >= 2 ? 'text-yellow-600' : 'text-red-600'}`}>
                                {overlapHours}h
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {overlapHours > 0 ? `${Math.floor(overlapStart)}:00 - ${Math.floor(overlapEnd)}:00 (your time)` : 'No overlap'}
                              </p>
                            </div>
                          </div>
                          <div className="mt-3 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${overlapHours >= 4 ? 'bg-green-500' : overlapHours >= 2 ? 'bg-yellow-500' : 'bg-red-500'}`}
                              style={{ width: `${(overlapHours / 8) * 100}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Briefings Tab */}
          <TabsContent value="briefings" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="h-5 w-5 text-purple-500" />
                  Daily Briefing Settings
                </CardTitle>
                <CardDescription>Configure automated email reports</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Morning Briefing */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-medium">Morning Briefing</h3>
                      <p className="text-sm text-muted-foreground">
                        Daily email with today's tasks, priorities, and schedule
                      </p>
                    </div>
                    <Switch
                      checked={briefingEnabled}
                      onCheckedChange={setBriefingEnabled}
                    />
                  </div>
                  {briefingEnabled && (
                    <div className="flex items-center gap-4 pl-4 border-l-2">
                      <Label>Send at:</Label>
                      <Input
                        type="time"
                        value={briefingTime}
                        onChange={(e) => setBriefingTime(e.target.value)}
                        className="w-32"
                      />
                    </div>
                  )}
                </div>

                {/* End of Day Report */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-medium">End of Day Report</h3>
                      <p className="text-sm text-muted-foreground">
                        Summary of completed tasks, blockers, and tomorrow's preview
                      </p>
                    </div>
                    <Switch
                      checked={eodReportEnabled}
                      onCheckedChange={setEodReportEnabled}
                    />
                  </div>
                  {eodReportEnabled && (
                    <div className="flex items-center gap-4 pl-4 border-l-2">
                      <Label>Send at:</Label>
                      <Input
                        type="time"
                        value={eodReportTime}
                        onChange={(e) => setEodReportTime(e.target.value)}
                        className="w-32"
                      />
                    </div>
                  )}
                </div>

                <Button onClick={handleSaveBriefingSettings}>
                  <Send className="h-4 w-4 mr-2" />
                  Save Briefing Settings
                </Button>
              </CardContent>
            </Card>

            {/* Send Now Section */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Send className="h-5 w-5 text-green-500" />
                  Send Emails Now
                </CardTitle>
                <CardDescription>Manually send briefings or reports to workers</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4">
                  {workload.map(item => (
                    <div key={item.worker.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="font-medium">{item.worker.name}</p>
                        <p className="text-sm text-muted-foreground">{item.worker.email || 'No email set'}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!item.worker.email}
                          onClick={async () => {
                            try {
                              const res = await fetch(`/api/va/email/morning-briefing/${item.worker.id}`, {
                                method: 'POST',
                                credentials: 'include',
                              });
                              if (res.ok) {
                                toast.success(`Morning briefing sent to ${item.worker.name}`);
                              } else {
                                const data = await res.json();
                                toast.error(data.error || 'Failed to send briefing');
                              }
                            } catch {
                              toast.error('Failed to send briefing');
                            }
                          }}
                        >
                          <Mail className="h-4 w-4 mr-1" />
                          Send Briefing
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              const res = await fetch(`/api/va/email/eod-report/${item.worker.id}`, {
                                method: 'POST',
                                credentials: 'include',
                              });
                              if (res.ok) {
                                toast.success(`EOD report for ${item.worker.name} sent to you`);
                              } else {
                                const data = await res.json();
                                toast.error(data.error || 'Failed to send report');
                              }
                            } catch {
                              toast.error('Failed to send report');
                            }
                          }}
                        >
                          <Calendar className="h-4 w-4 mr-1" />
                          Send EOD Report
                        </Button>
                      </div>
                    </div>
                  ))}
                  {workload.length === 0 && (
                    <p className="text-center text-muted-foreground py-4">Add workers to send emails</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Preview */}
            <Card>
              <CardHeader>
                <CardTitle>Briefing Preview</CardTitle>
                <CardDescription>Example of what your daily briefing will look like</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="border rounded-lg p-4 bg-secondary/30">
                  <h3 className="font-bold text-lg mb-2">Daily Briefing - {new Date().toLocaleDateString()}</h3>
                  <div className="space-y-3 text-sm">
                    <div>
                      <strong>Today's Priority Tasks:</strong>
                      <ul className="list-disc list-inside ml-2 mt-1">
                        <li className="text-red-600">[CRITICAL] Review client proposal - Due 2:00 PM</li>
                        <li className="text-orange-600">[URGENT] Respond to support tickets</li>
                      </ul>
                    </div>
                    <div>
                      <strong>VA Status:</strong>
                      <ul className="list-disc list-inside ml-2 mt-1">
                        {workload.slice(0, 3).map(w => (
                          <li key={w.worker.id}>
                            {w.worker.status === 'active' ? '✅' : w.worker.status === 'on_leave' ? '🟡' : '⚪'} {w.worker.name} - {w.statusCounts.in_progress} active tasks
                          </li>
                        ))}
                      </ul>
                    </div>

                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="paylogs" className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4 flex-wrap gap-4">
                <div>
                  <CardTitle className="text-lg font-bold">Worker Selection</CardTitle>
                  <CardDescription>Select a virtual worker to manage their weekly pay log, merits, and demerits.</CardDescription>
                </div>
                <div className="w-64">
                  <Select
                    value={selectedWorkerId?.toString() || ''}
                    onValueChange={(val) => setSelectedWorkerId(val ? parseInt(val) : null)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a worker..." />
                    </SelectTrigger>
                    <SelectContent>
                      {workload.map((item) => (
                        <SelectItem key={item.worker.id} value={(item.worker.userId || item.worker.id).toString()}>
                          {item.worker.name} ({item.worker.email || 'No email'})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
            </Card>

            {selectedWorkerId && (
              <WeeklyPayCalculator vaId={selectedWorkerId} />
            )}
          </TabsContent>
        </Tabs>
      </main>

      {/* Edit Worker Dialog */}
      <Dialog open={showEditWorker} onOpenChange={setShowEditWorker}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Worker Settings</DialogTitle>
          </DialogHeader>
          {editingWorker && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input
                  value={editingWorker.name}
                  onChange={(e) => setEditingWorker({ ...editingWorker, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Email *</Label>
                <Input
                  type="email"
                  value={editingWorker.email || ''}
                  onChange={(e) => setEditingWorker({ ...editingWorker, email: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Change Password</Label>
                <Input
                  type="password"
                  value={editWorkerPassword}
                  onChange={(e) => setEditWorkerPassword(e.target.value)}
                  placeholder="Leave blank to keep current password"
                />
              </div>
              <div className="space-y-2">
                <Label>Trello Member ID</Label>
                <Input
                  value={editingWorker.trelloMemberId || ''}
                  onChange={(e) => setEditingWorker({ ...editingWorker, trelloMemberId: e.target.value })}
                  placeholder="e.g., 664ed797b37eb4605ed64bc1"
                />
              </div>
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Select value={editingWorker.timezone} onValueChange={(v) => setEditingWorker({ ...editingWorker, timezone: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Hourly Rate</Label>
                  <Input
                    type="number"
                    value={editingWorker.hourlyRate ? editingWorker.hourlyRate / 100 : ''}
                    onChange={(e) => setEditingWorker({ ...editingWorker, hourlyRate: e.target.value ? parseInt(e.target.value) * 100 : null })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Select value={editingWorker.currency || 'USD'} onValueChange={(v) => setEditingWorker({ ...editingWorker, currency: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Working Hours Section */}
              <div className="border-t pt-4 mt-4">
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Working Hours
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Start Time</Label>
                    <Select value={editingWorker.workStartHour.toString()} onValueChange={(v) => setEditingWorker({ ...editingWorker, workStartHour: parseInt(v) })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>End Time</Label>
                    <Select value={editingWorker.workEndHour.toString()} onValueChange={(v) => setEditingWorker({ ...editingWorker, workEndHour: parseInt(v) })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                
                {/* Working Days */}
                <div className="mt-4">
                  <Label className="mb-2 block">Working Days</Label>
                  <div className="flex flex-wrap gap-2">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => {
                      const days = (editingWorker.workingDays || '1,2,3,4,5').split(',').filter(d => d).map(d => parseInt(d));
                      const isSelected = days.includes(index);
                      return (
                        <Button
                          key={day}
                          type="button"
                          variant={isSelected ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => {
                            const newDays = isSelected
                              ? days.filter(d => d !== index)
                              : [...days, index].sort();
                            setEditingWorker({ ...editingWorker, workingDays: newDays.join(',') });
                          }}
                        >
                          {day}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Lunch Break Section */}
              <div className="border-t pt-4 mt-4">
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <Briefcase className="h-4 w-4" />
                  Lunch Break
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Lunch Time</Label>
                    <Select value={(editingWorker.lunchTime ?? 12).toString()} onValueChange={(v) => setEditingWorker({ ...editingWorker, lunchTime: parseInt(v) })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Duration</Label>
                    <Select value={(editingWorker.lunchDuration ?? 60).toString()} onValueChange={(v) => setEditingWorker({ ...editingWorker, lunchDuration: parseInt(v) })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">No break</SelectItem>
                        <SelectItem value="30">30 min</SelectItem>
                        <SelectItem value="45">45 min</SelectItem>
                        <SelectItem value="60">1 hour</SelectItem>
                        <SelectItem value="90">1.5 hours</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Breakfast Break Section */}
              <div className="border-t pt-4 mt-4">
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Breakfast Break (Optional)
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Breakfast Time</Label>
                    <Select value={(editingWorker.breakfastTime ?? -1).toString()} onValueChange={(v) => setEditingWorker({ ...editingWorker, breakfastTime: v === '-1' ? null : parseInt(v) })}>
                      <SelectTrigger>
                        <SelectValue placeholder="No breakfast break" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="-1">No breakfast break</SelectItem>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Duration</Label>
                    <Select 
                      value={(editingWorker.breakfastDuration ?? 0).toString()} 
                      onValueChange={(v) => setEditingWorker({ ...editingWorker, breakfastDuration: parseInt(v) })}
                      disabled={editingWorker.breakfastTime === null}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">No break</SelectItem>
                        <SelectItem value="15">15 min</SelectItem>
                        <SelectItem value="30">30 min</SelectItem>
                        <SelectItem value="45">45 min</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Dinner Break Section */}
              <div className="border-t pt-4 mt-4">
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Dinner Break (Optional)
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Dinner Time</Label>
                    <Select value={(editingWorker.dinnerTime ?? -1).toString()} onValueChange={(v) => setEditingWorker({ ...editingWorker, dinnerTime: v === '-1' ? null : parseInt(v) })}>
                      <SelectTrigger>
                        <SelectValue placeholder="No dinner break" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="-1">No dinner break</SelectItem>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={i.toString()}>{i.toString().padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Duration</Label>
                    <Select 
                      value={(editingWorker.dinnerDuration ?? 0).toString()} 
                      onValueChange={(v) => setEditingWorker({ ...editingWorker, dinnerDuration: parseInt(v) })}
                      disabled={editingWorker.dinnerTime === null}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">No break</SelectItem>
                        <SelectItem value="30">30 min</SelectItem>
                        <SelectItem value="45">45 min</SelectItem>
                        <SelectItem value="60">1 hour</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditWorker(false)}>Cancel</Button>
            <Button onClick={handleSaveWorkerSettings} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>



      {/* Re-analysis Progress Modal */}
      <ReanalysisProgressModal
        open={showReanalysisModal}
        onOpenChange={setShowReanalysisModal}
        preselectedBoardId={selectedBoardForReanalysis?.id}
        preselectedBoardName={selectedBoardForReanalysis?.name}
        onComplete={(results) => {
          setReanalysisProgress(results);
          toast.success(`Re-analysis complete: ${results.processed} processed, ${results.failed} failed`);
        }}
      />
    </div>
  );
}
