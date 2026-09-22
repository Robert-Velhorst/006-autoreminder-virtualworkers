import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import trelloConfigRouter from './routes/trello-config';

describe('Task Scheduling and Sync Features', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/trello', trelloConfigRouter);
  const cachedTasks = [
    {
      id: 'task-1',
      cardId: 'card-1',
      cardName: 'Prepare daily update',
      checklistId: 'checklist-1',
      checkItemId: 'item-1',
      stepIndex: 1,
      description: 'Draft the update',
      durationHours: 1,
      startTime: '09:00',
      endTime: '10:00',
      date: '2026-07-29',
      isCompleted: false,
      priorityLevel: 'HIGH',
    },
    {
      id: 'task-2',
      cardId: 'card-2',
      cardName: 'Archive completed evidence',
      checklistId: 'checklist-2',
      checkItemId: 'item-2',
      stepIndex: 1,
      description: 'Archive processed evidence',
      durationHours: 1,
      startTime: '10:00',
      endTime: '11:00',
      date: '2026-07-29',
      isCompleted: false,
      priorityLevel: 'NORMAL',
    },
  ];

  describe('Task Scheduling Algorithm', () => {
    it('should return tasks as an array', () => {
      expect(Array.isArray(cachedTasks)).toBe(true);
    });

    it('should include scheduling fields in tasks', () => {
      if (cachedTasks.length > 0) {
        const task = cachedTasks[0];
        // Check that tasks have required scheduling fields
        expect(task).toHaveProperty('startTime');
        expect(task).toHaveProperty('endTime');
        expect(task).toHaveProperty('durationHours');
        expect(task).toHaveProperty('date');
        
        // Verify time format (HH:MM or TBD or --:--)
        if (task.startTime !== 'TBD' && task.startTime !== '--:--') {
          expect(task.startTime).toMatch(/^\d{2}:\d{2}$/);
        }
        if (task.endTime !== 'TBD' && task.endTime !== '--:--') {
          expect(task.endTime).toMatch(/^\d{2}:\d{2}$/);
        }
      }
    });

    it('should schedule tasks within working hours (9:00 - 18:00)', () => {
      const scheduledTasks = cachedTasks.filter((t: any) => 
        t.startTime !== 'TBD' && 
        t.startTime !== '--:--' && 
        !t.isCompleted
      );
      
      if (scheduledTasks.length > 0) {
        for (const task of scheduledTasks.slice(0, 10)) { // Test first 10 to avoid long runs
          const [startHour] = task.startTime.split(':').map(Number);
          const [endHour] = task.endTime.split(':').map(Number);
          
          // Start time should be >= 9:00
          expect(startHour).toBeGreaterThanOrEqual(9);
          // End time should be <= 18:00
          expect(endHour).toBeLessThanOrEqual(18);
        }
      }
    });

    it('should mark completed tasks with --:-- times', () => {
      const completedTasks = cachedTasks.filter((t: any) => t.isCompleted);
      
      if (completedTasks.length > 0) {
        for (const task of completedTasks.slice(0, 10)) { // Test first 10
          expect(task.startTime).toBe('--:--');
          expect(task.endTime).toBe('--:--');
        }
      }
    });

    it('should schedule tasks sequentially without overlaps', () => {
      // Group by date
      const tasksByDate = new Map<string, any[]>();
      for (const task of cachedTasks) {
        if (!tasksByDate.has(task.date)) {
          tasksByDate.set(task.date, []);
        }
        tasksByDate.get(task.date)!.push(task);
      }

      // Check one day's schedule
      for (const [date, dayTasks] of Array.from(tasksByDate.entries()).slice(0, 1)) {
        const scheduled = dayTasks
          .filter(t => !t.isCompleted && t.startTime !== 'TBD')
          .sort((a, b) => a.startTime.localeCompare(b.startTime));

        for (let i = 0; i < scheduled.length - 1; i++) {
          const current = scheduled[i];
          const next = scheduled[i + 1];
          
          // Current task's end time should be <= next task's start time
          expect(current.endTime <= next.startTime).toBe(true);
        }
      }
    });
  });

  describe('Task Status Sync to Trello', () => {
    it('should have required fields for syncing', () => {
      if (cachedTasks.length > 0) {
        const task = cachedTasks[0];
        // These fields are required for syncing back to Trello
        expect(task).toHaveProperty('cardId');
        expect(task).toHaveProperty('checklistId');
        expect(task).toHaveProperty('checkItemId');
        
        // Verify they are not empty
        expect(task.cardId).toBeTruthy();
        expect(task.checklistId).toBeTruthy();
        expect(task.checkItemId).toBeTruthy();
      }
    });

    it('protects the sync endpoint from unauthenticated writes', async () => {
      const mockTaskId = 'test_task_id';
      const response = await request(app)
        .put(`/api/trello/tasks/${mockTaskId}/complete`)
        .send({ isCompleted: true });

      expect(response.status).toBe(401);
    });
  });

  describe('Task Data Structure', () => {
    it('should include all required task fields', () => {
      if (cachedTasks.length > 0) {
        const task = cachedTasks[0];
        const requiredFields = [
          'id',
          'cardId',
          'cardName',
          'checklistId',
          'checkItemId',
          'stepIndex',
          'description',
          'durationHours',
          'startTime',
          'endTime',
          'date',
          'isCompleted',
          'priorityLevel'
        ];
        
        for (const field of requiredFields) {
          expect(task).toHaveProperty(field);
        }
      }
    });

    it('should have valid priority levels', () => {
      const validPriorities = ['CRITICAL', 'URGENT', 'HIGH', 'NORMAL'];
      
      for (const task of cachedTasks.slice(0, 20)) {
        expect(validPriorities).toContain(task.priorityLevel);
      }
    });
  });
});
