import { describe, expect, it } from 'vitest';
import { scheduleTasksByTime, type WorkerSettings } from './aptlss';

describe('scheduleTasksByTime worker settings', () => {
  it('uses a worker-specific break and workday end when it validates a task', () => {
    const workerSettings = new Map<number, WorkerSettings>([
      [7, {
        workStartHour: 9,
        workEndHour: 12,
        workingDays: [1, 2, 3, 4, 5],
        schedulingOptions: {
          breakfastBreakStart: 10,
          breakfastBreakDuration: 30,
          lunchBreakStart: 99,
          lunchBreakDuration: 0,
        },
      }],
    ]);

    const result = scheduleTasksByTime([
      {
        id: 'worker-break-task',
        date: '2026-07-06',
        workerId: 7,
        cardName: 'Worker-specific schedule',
        durationHours: 2,
        priorityLevel: 'NORMAL',
        taskType: 'admin',
        stepIndex: 0,
      },
    ], 9, 18, [1, 2, 3, 4, 5], [], { lunchBreakDuration: 0 }, workerSettings);

    expect(result.scheduled).toHaveLength(0);
    expect(result.overflow).toHaveLength(1);
    expect(result.overflow[0].rejectionReason).toContain('12:00');
  });

  it('does not subtract a break outside the work window from available capacity', () => {
    const result = scheduleTasksByTime([
      {
        id: 'outside-break-task',
        date: '2026-07-06',
        cardName: 'Outside break capacity',
        durationHours: 7.5,
        priorityLevel: 'NORMAL',
        taskType: 'admin',
        stepIndex: 0,
      },
    ], 9, 18, [1, 2, 3, 4, 5], [], {
      lunchBreakDuration: 0,
      dinnerBreakStart: 20,
      dinnerBreakDuration: 120,
    });

    expect(result.overflow).toHaveLength(0);
    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0]).toMatchObject({ startTime: '09:00', endTime: '16:30' });
  });

  it('enforces a worker-specific daily capacity limit', () => {
    const workerSettings = new Map<number, WorkerSettings>([
      [8, {
        workStartHour: 9,
        workEndHour: 18,
        workingDays: [1, 2, 3, 4, 5],
        schedulingOptions: {
          lunchBreakDuration: 0,
          dailyHoursMax: 4,
        },
      }],
    ]);

    const result = scheduleTasksByTime([
      {
        id: 'worker-capacity-task',
        date: '2026-07-06',
        workerId: 8,
        cardName: 'Worker daily capacity',
        durationHours: 5,
        priorityLevel: 'NORMAL',
        taskType: 'admin',
        stepIndex: 0,
      },
    ], 9, 18, [1, 2, 3, 4, 5], [], { lunchBreakDuration: 0 }, workerSettings);

    expect(result.scheduled).toHaveLength(0);
    expect(result.overflow).toHaveLength(1);
    expect(result.overflow[0].rejectionReason).toContain('remaining capacity (240min)');
  });
});
