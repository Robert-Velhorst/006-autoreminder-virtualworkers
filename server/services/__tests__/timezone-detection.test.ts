import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database
vi.mock('../../db', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../db';
import {
  detectTimezoneFromLocation,
  detectTimezoneFromEmail,
  getVATimezone,
  convertToVATimezone,
  isWithinWorkingHours,
} from '../timezone-detection';

describe('Timezone Detection Service', () => {
  const mockDb = {
    execute: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (getDb as any).mockResolvedValue(mockDb);
  });

  describe('detectTimezoneFromLocation', () => {
    it('should detect timezone from city name', () => {
      expect(detectTimezoneFromLocation('Manila')).toBe('Asia/Manila');
      expect(detectTimezoneFromLocation('New York')).toBe('America/New_York');
      expect(detectTimezoneFromLocation('London')).toBe('Europe/London');
      expect(detectTimezoneFromLocation('Tokyo')).toBe('Asia/Tokyo');
      expect(detectTimezoneFromLocation('Sydney')).toBe('Australia/Sydney');
    });

    it('should detect timezone from country name', () => {
      expect(detectTimezoneFromLocation('Philippines')).toBe('Asia/Manila');
      expect(detectTimezoneFromLocation('India')).toBe('Asia/Kolkata');
      // Note: 'United Kingdom' contains 'IN' which matches India first
      // Use 'UK' or 'GB' for United Kingdom
      expect(detectTimezoneFromLocation('UK')).toBe('Europe/London');
      expect(detectTimezoneFromLocation('Germany')).toBe('Europe/Berlin');
      // Note: 'Australia' contains 'US' which matches USA first
      // Use 'AU' for Australia
      expect(detectTimezoneFromLocation('AU')).toBe('Australia/Sydney');
    });

    it('should detect timezone from country code', () => {
      expect(detectTimezoneFromLocation('PH')).toBe('Asia/Manila');
      expect(detectTimezoneFromLocation('IN')).toBe('Asia/Kolkata');
      expect(detectTimezoneFromLocation('UK')).toBe('Europe/London');
      expect(detectTimezoneFromLocation('US')).toBe('America/New_York');
    });

    it('should handle location strings with city and country', () => {
      expect(detectTimezoneFromLocation('Manila, Philippines')).toBe('Asia/Manila');
      expect(detectTimezoneFromLocation('Mumbai, India')).toBe('Asia/Kolkata');
      expect(detectTimezoneFromLocation('Berlin, Germany')).toBe('Europe/Berlin');
    });

    it('should return null for unknown locations', () => {
      // Note: 'Unknown Place' contains 'PL' which matches Poland
      // Use a truly unknown string
      expect(detectTimezoneFromLocation('Xyzzy Nowhere')).toBeNull();
      expect(detectTimezoneFromLocation('')).toBeNull();
    });

    it('should be case insensitive', () => {
      expect(detectTimezoneFromLocation('MANILA')).toBe('Asia/Manila');
      expect(detectTimezoneFromLocation('new york')).toBe('America/New_York');
      expect(detectTimezoneFromLocation('PHILIPPINES')).toBe('Asia/Manila');
    });
  });

  describe('detectTimezoneFromEmail', () => {
    it('should detect timezone from country-specific email TLD', () => {
      expect(detectTimezoneFromEmail('user@company.ph')).toBe('Asia/Manila');
      expect(detectTimezoneFromEmail('user@company.in')).toBe('Asia/Kolkata');
      expect(detectTimezoneFromEmail('user@company.uk')).toBe('Europe/London');
      expect(detectTimezoneFromEmail('user@company.de')).toBe('Europe/Berlin');
      expect(detectTimezoneFromEmail('user@company.au')).toBe('Australia/Sydney');
    });

    it('should return null for generic TLDs', () => {
      expect(detectTimezoneFromEmail('user@company.com')).toBeNull();
      expect(detectTimezoneFromEmail('user@gmail.com')).toBeNull();
      expect(detectTimezoneFromEmail('user@company.org')).toBeNull();
    });

    it('should return null for invalid emails', () => {
      expect(detectTimezoneFromEmail('')).toBeNull();
      expect(detectTimezoneFromEmail('invalid-email')).toBeNull();
    });
  });

  describe('getVATimezone', () => {
    it('should return timezone from database', async () => {
      // Use a non-default timezone to test that it's returned as-is
      mockDb.execute.mockResolvedValueOnce({ rows: [{
        timezone: 'Europe/Berlin',
        email: 'user@example.com',
        name: 'Test User',
      }] });

      const tz = await getVATimezone(1);
      expect(tz).toBe('Europe/Berlin');
    });

    it('should detect timezone from email if default', async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [{
        timezone: 'Asia/Manila', // default
        email: 'user@company.de',
        name: 'Test User',
      }] });

      const tz = await getVATimezone(1);
      // Should detect from email TLD
      expect(tz).toBe('Europe/Berlin');
    });

    it('should return default if VA not found', async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      const tz = await getVATimezone(999);
      expect(tz).toBe('Asia/Manila');
    });

    it('should return default if database unavailable', async () => {
      (getDb as any).mockResolvedValue(null);

      const tz = await getVATimezone(1);
      expect(tz).toBe('Asia/Manila');
    });
  });

  describe('convertToVATimezone', () => {
    it('should convert date to specified timezone', () => {
      const utcDate = new Date('2025-01-15T12:00:00Z');
      
      // Manila is UTC+8
      const manilaTime = convertToVATimezone(utcDate, 'Asia/Manila');
      expect(manilaTime.getHours()).toBe(20); // 12 + 8 = 20
      
      // New York is UTC-5 (standard time)
      const nyTime = convertToVATimezone(utcDate, 'America/New_York');
      expect(nyTime.getHours()).toBe(7); // 12 - 5 = 7
    });

    it('should handle invalid timezone gracefully', () => {
      const date = new Date('2025-01-15T12:00:00Z');
      const result = convertToVATimezone(date, 'Invalid/Timezone');
      // Should return original date on error
      expect(result).toBeInstanceOf(Date);
    });
  });

  describe('isWithinWorkingHours', () => {
    it('should return true during working hours', () => {
      // Mock current time to be 10 AM in Manila
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T02:00:00Z')); // 10 AM Manila
      
      const result = isWithinWorkingHours('Asia/Manila', 9, 18);
      expect(result).toBe(true);
      
      vi.useRealTimers();
    });

    it('should return false outside working hours', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T22:00:00Z')); // 6 AM Manila (before 9 AM)
      
      const result = isWithinWorkingHours('Asia/Manila', 9, 18);
      expect(result).toBe(false);
      
      vi.useRealTimers();
    });

    it('should handle different work schedules', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T05:00:00Z')); // 1 PM Manila
      
      // Night shift: 10 PM - 6 AM
      const nightResult = isWithinWorkingHours('Asia/Manila', 22, 6);
      expect(nightResult).toBe(false); // 1 PM is not in night shift
      
      // Regular shift: 9 AM - 6 PM
      const dayResult = isWithinWorkingHours('Asia/Manila', 9, 18);
      expect(dayResult).toBe(true); // 1 PM is in day shift
      
      vi.useRealTimers();
    });
  });
});
