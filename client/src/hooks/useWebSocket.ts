import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '@/_core/hooks/useAuth';

interface UseWebSocketOptions {
  onManagerUpdated?: (data: { runId: number; assessedAt: string; urgent: boolean }) => void;
  onTaskCompleted?: (data: any) => void;
  onTaskRescheduled?: (data: any) => void;
  onTaskPriorityChanged?: (data: any) => void;
  onCacheInvalidated?: () => void;
}

interface WebSocketStatus {
  connected: boolean;
  connectedClients: number;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const { user } = useAuth();
  const userIdentity = user?.openId;
  const socketRef = useRef<Socket | null>(null);
  const [status, setStatus] = useState<WebSocketStatus>({
    connected: false,
    connectedClients: 0,
  });

  // Keep a ref to options so event handlers always call the latest callbacks
  // without the socket connection needing to restart.
  // This is the key fix: updating optionsRef.current synchronously on every render
  // means we never need to include callbacks in the useEffect dependency array.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    setStatus({ connected: false, connectedClients: 0 });
    if (!userIdentity) {
      return;
    }

    // Reconnect when identity changes, not when callback references change.
    const socket = io({
      path: '/ws',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 15000,
      reconnectionAttempts: 5,
    });

    socketRef.current = socket;

    // Connection events
    socket.on('connect', () => {
      console.log('[WebSocket] Connected');
      setStatus(prev => ({ ...prev, connected: true }));

    });

    socket.on('connect_error', (error: Error) => {
      console.error('[WebSocket] Connection error:', error);
      setStatus({ connected: false, connectedClients: 0 });
    });

    socket.on('disconnect', () => {
      console.log('[WebSocket] Disconnected');
      setStatus({ connected: false, connectedClients: 0 });
    });

    socket.on('authenticated', (data: { success: boolean; connectedClients: number }) => {
      console.log('[WebSocket] Authenticated', data);
      setStatus(prev => ({ ...prev, connectedClients: data.connectedClients }));
    });

    // Task events — always read from ref so latest callback is used without reconnecting
    socket.on('task:completed', (data: any) => {
      console.log('[WebSocket] Task completed', data);
      optionsRef.current.onTaskCompleted?.(data);
    });

    socket.on('task:rescheduled', (data: any) => {
      console.log('[WebSocket] Task rescheduled', data);
      optionsRef.current.onTaskRescheduled?.(data);
    });

    // Cache events
    socket.on('cache:invalidated', () => {
      console.log('[WebSocket] Cache invalidated');
      optionsRef.current.onCacheInvalidated?.();
    });

    socket.on('task:priority-changed', (data: any) => {
      console.log('[WebSocket] Task priority changed:', data);
      optionsRef.current.onTaskPriorityChanged?.(data);
    });

    socket.on('aptlss:manager-updated', (data: { runId: number; assessedAt: string; urgent: boolean }) => {
      optionsRef.current.onManagerUpdated?.(data);
    });

    // Reconnection events
    const onReconnect = (attemptNumber: number) => {
      console.log(`[WebSocket] Reconnected after ${attemptNumber} attempts`);
    };

    const onReconnectError = (error: Error) => {
      console.error('[WebSocket] Reconnection error:', error);
    };

    const onReconnectFailed = () => {
      console.error('[WebSocket] Reconnection failed');
    };
    socket.io.on('reconnect', onReconnect);
    socket.io.on('reconnect_error', onReconnectError);
    socket.io.on('reconnect_failed', onReconnectFailed);

    // Never retain a socket authenticated for a previous identity.
    return () => {
      console.log('[WebSocket] Disconnecting');
      socket.io.off('reconnect', onReconnect);
      socket.io.off('reconnect_error', onReconnectError);
      socket.io.off('reconnect_failed', onReconnectFailed);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [userIdentity]);

  // Helper functions to emit events
  const emitTaskComplete = (data: { taskId: string; isCompleted: boolean }) => {
    socketRef.current?.emit('task:complete', data);
  };

  const emitTaskReschedule = (data: any) => {
    socketRef.current?.emit('task:reschedule', data);
  };

  const emitCacheInvalidate = () => {
    socketRef.current?.emit('cache:invalidate');
  };

  return {
    status,
    emitTaskComplete,
    emitTaskReschedule,
    emitCacheInvalidate,
  };
}
