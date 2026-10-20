import { useState, useEffect, useRef } from 'react';
import { Bell, Check, CheckCheck, Trash2, Clock, AlertTriangle, CheckCircle, Mail, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface Notification {
  id: number;
  title: string;
  content: string;
  notificationType: string;
  taskId: string | null;
  taskName: string | null;
  dueDate: string | null;
  channel: string;
  deliveryStatus: string;
  isRead: number;
  createdAt: string;
}

const notificationIcons: Record<string, React.ReactNode> = {
  task_assigned: <Mail className="h-4 w-4 text-blue-500" />,
  task_due_soon: <Clock className="h-4 w-4 text-amber-500" />,
  task_overdue: <AlertTriangle className="h-4 w-4 text-red-500" />,
  task_completed: <CheckCircle className="h-4 w-4 text-green-500" />,
  daily_digest: <Mail className="h-4 w-4 text-purple-500" />,
  general: <Bell className="h-4 w-4 text-gray-500" />,
};

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => document.visibilityState === 'visible',
  );

  const fetchNotifications = async () => {
    try {
      const response = await fetch('/api/notifications?limit=20', {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        setNotifications(data.notifications);
      }
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
    }
  };

  const fetchUnreadCount = async () => {
    try {
      const response = await fetch('/api/notifications/unread-count', {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        setUnreadCount(data.unreadCount);
      }
    } catch (error) {
      console.error('Failed to fetch unread count:', error);
    }
  };

  useEffect(() => {
    const syncVisibility = () => {
      setIsDocumentVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  useEffect(() => {
    if (!isDocumentVisible) return;
    void fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [isDocumentVisible]);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetchNotifications().finally(() => setLoading(false));
    }
  }, [isOpen]);

  const markAsRead = async (id: number) => {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: 'POST',
        credentials: 'include',
      });
      setNotifications(prev =>
        prev.map(n => (n.id === id ? { ...n, isRead: 1 } : n))
      );
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Failed to mark as read:', error);
    }
  };

  const markAllAsRead = async () => {
    try {
      await fetch('/api/notifications/mark-all-read', {
        method: 'POST',
        credentials: 'include',
      });
      setNotifications(prev => prev.map(n => ({ ...n, isRead: 1 })));
      setUnreadCount(0);
    } catch (error) {
      console.error('Failed to mark all as read:', error);
    }
  };

  const deleteNotification = async (id: number) => {
    try {
      await fetch(`/api/notifications/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      setNotifications(prev => prev.filter(n => n.id !== id));
      const notification = notifications.find(n => n.id === id);
      if (notification && notification.isRead === 0) {
        setUnreadCount(prev => Math.max(0, prev - 1));
      }
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-medium">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-1rem))] p-0" align="end">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={markAllAsRead}
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Mark all read
            </Button>
          )}
        </div>

        <ScrollArea className="h-[400px]">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Bell className="h-10 w-10 mb-3 opacity-50" />
              <p className="text-sm">No notifications yet</p>
              <p className="text-xs mt-1">You're all caught up!</p>
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={cn(
                    'px-4 py-3 hover:bg-muted/50 transition-colors relative group',
                    notification.isRead === 0 && 'bg-primary/5'
                  )}
                >
                  <button type="button" className="flex w-full gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void (async () => {
                      if (notification.isRead === 0) await markAsRead(notification.id);
                      if (notification.taskId?.startsWith('founder-decision:')) {
                        setIsOpen(false);
                        window.location.href = '/founder?tab=founder-decisions';
                      }
                    })()}>
                    <div className="mt-0.5">
                      {notificationIcons[notification.notificationType] || notificationIcons.general}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className={cn(
                          'text-sm line-clamp-2',
                          notification.isRead === 0 ? 'font-medium' : 'text-muted-foreground'
                        )}>
                          {notification.taskName || notification.title}
                        </p>
                        {notification.isRead === 0 && (
                          <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0 mt-1.5" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {notification.content}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-xs text-muted-foreground">
                          {formatTime(notification.createdAt)}
                        </span>
                        {notification.dueDate && (
                          <span className="text-xs text-amber-600">
                            Due: {new Date(notification.dueDate).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>

                  {/* Action buttons on hover */}
                  <div className="absolute right-2 top-2 flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    {notification.isRead === 0 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label="Mark notification as read"
                        onClick={(e) => {
                          void markAsRead(notification.id);
                        }}
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      aria-label="Delete notification"
                      onClick={(e) => {
                        void deleteNotification(notification.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="border-t px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs"
            onClick={() => {
              setIsOpen(false);
              window.location.href = '/settings';
            }}
          >
            Notification Settings
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
