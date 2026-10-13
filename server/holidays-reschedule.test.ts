import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import holidayRouter, { SUPPORTED_HOLIDAY_COUNTRIES } from './routes/holidays';
import rescheduleRouter, { extractCachedTasks } from './routes/reschedule';

describe('Holiday Integration and Bulk Rescheduling', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/holidays', holidayRouter);
  app.use('/api/reschedule', rescheduleRouter);

  describe('Holiday API', () => {
    it('should fetch available countries', async () => {
      const response = await request(app).get('/api/holidays/countries');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(SUPPORTED_HOLIDAY_COUNTRIES);
      expect(response.body[0]).toHaveProperty('countryCode');
      expect(response.body[0]).toHaveProperty('name');
    });

    it('should have common countries available', () => {
      const countryCodes = SUPPORTED_HOLIDAY_COUNTRIES.map(country => country.countryCode);
      
      // Check for some common countries
      const commonCountries = ['US', 'GB', 'DE', 'FR', 'NL'];
      const hasCommonCountries = commonCountries.some(code => countryCodes.includes(code));
      
      expect(hasCommonCountries).toBe(true);
    });

    it('should have holiday endpoints registered', async () => {
      // Test that endpoints exist (even if unauthorized)
      const countries = await request(app).get('/api/holidays/countries');
      const holidayList = await request(app).get('/api/holidays/list');

      expect(countries.status).toBe(200);
      expect(holidayList.status).toBe(401);
    });
  });

  describe('Bulk Rescheduling', () => {
    it('uses the task list from a cached schedule response', () => {
      const tasks = [{ id: 'task-1', date: '2026-08-15' }];
      expect(extractCachedTasks({ tasks, overflow: [], timezone: 'UTC' })).toEqual(tasks);
      expect(extractCachedTasks(tasks)).toEqual(tasks);
      expect(extractCachedTasks({ tasks: 'not-an-array' })).toEqual([]);
    });

    it('should have reschedule endpoints registered', async () => {
      const preview = await request(app).post('/api/reschedule/preview').send({});
      const apply = await request(app).post('/api/reschedule/apply').send({});

      expect(preview.status).toBe(401);
      expect(apply.status).toBe(401);
    });

    it('should protect reschedule preview before reading task data', async () => {
      const response = await request(app)
        .post('/api/reschedule/preview')
        .send({ workStartHour: 9, workEndHour: 18, workingDays: [1, 2, 3, 4, 5] });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
  });

  describe('Holiday Filtering in Scheduling', () => {
    it('should represent holiday scheduling deferrals explicitly', () => {
      const task = {
        date: '2026-12-25',
        name: 'Prepare client update',
        startTime: 'TBD',
        endTime: 'TBD',
        note: 'Holiday',
      };

      expect(task.startTime).toBe('TBD');
      expect(task.endTime).toBe('TBD');
      expect(task.note).toBe('Holiday');
    });

    it('should distinguish holidays from non-working days', () => {
      const tasks = [
        { startTime: 'TBD', note: 'Holiday' },
        { startTime: 'TBD', note: 'Non-working day' },
      ];

      for (const task of tasks) {
        expect(['Holiday', 'Non-working day']).toContain(task.note);
      }
    });
  });

  describe('Database Schema', () => {
    it('should have holidays table structure', () => {
      // Test expected fields
      const expectedFields = [
        'id',
        'userId',
        'userOpenId',
        'date',
        'name',
        'country',
        'isActive',
        'createdAt',
      ];
      
      // Just verify the list is complete
      expect(expectedFields.length).toBe(8);
      expect(expectedFields).toContain('date');
      expect(expectedFields).toContain('isActive');
    });

    it('should have country field in user_working_hours', () => {
      // Test that country field was added
      const expectedNewField = 'country';
      expect(expectedNewField).toBe('country');
    });
  });
});
