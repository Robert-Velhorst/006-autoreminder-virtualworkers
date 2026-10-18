/**
 * Timezone Detection Service
 * 
 * Auto-detects timezone from VA profile location/country
 * and updates scheduled check-ins accordingly.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { vaProfiles } from '../../drizzle/schema.postgres';

// Country to timezone mapping (most common timezone per country)
const COUNTRY_TIMEZONES: Record<string, string> = {
  // Asia
  'Philippines': 'Asia/Manila',
  'PH': 'Asia/Manila',
  'India': 'Asia/Kolkata',
  'IN': 'Asia/Kolkata',
  'Pakistan': 'Asia/Karachi',
  'PK': 'Asia/Karachi',
  'Bangladesh': 'Asia/Dhaka',
  'BD': 'Asia/Dhaka',
  'Indonesia': 'Asia/Jakarta',
  'ID': 'Asia/Jakarta',
  'Vietnam': 'Asia/Ho_Chi_Minh',
  'VN': 'Asia/Ho_Chi_Minh',
  'Thailand': 'Asia/Bangkok',
  'TH': 'Asia/Bangkok',
  'Malaysia': 'Asia/Kuala_Lumpur',
  'MY': 'Asia/Kuala_Lumpur',
  'Singapore': 'Asia/Singapore',
  'SG': 'Asia/Singapore',
  'China': 'Asia/Shanghai',
  'CN': 'Asia/Shanghai',
  'Japan': 'Asia/Tokyo',
  'JP': 'Asia/Tokyo',
  'South Korea': 'Asia/Seoul',
  'KR': 'Asia/Seoul',
  'Taiwan': 'Asia/Taipei',
  'TW': 'Asia/Taipei',
  'Hong Kong': 'Asia/Hong_Kong',
  'HK': 'Asia/Hong_Kong',
  'Sri Lanka': 'Asia/Colombo',
  'LK': 'Asia/Colombo',
  'Nepal': 'Asia/Kathmandu',
  'NP': 'Asia/Kathmandu',
  
  // Europe
  'United Kingdom': 'Europe/London',
  'UK': 'Europe/London',
  'GB': 'Europe/London',
  'Germany': 'Europe/Berlin',
  'DE': 'Europe/Berlin',
  'France': 'Europe/Paris',
  'FR': 'Europe/Paris',
  'Netherlands': 'Europe/Amsterdam',
  'NL': 'Europe/Amsterdam',
  'Spain': 'Europe/Madrid',
  'ES': 'Europe/Madrid',
  'Italy': 'Europe/Rome',
  'IT': 'Europe/Rome',
  'Poland': 'Europe/Warsaw',
  'PL': 'Europe/Warsaw',
  'Ukraine': 'Europe/Kiev',
  'UA': 'Europe/Kiev',
  'Romania': 'Europe/Bucharest',
  'RO': 'Europe/Bucharest',
  'Portugal': 'Europe/Lisbon',
  'PT': 'Europe/Lisbon',
  'Greece': 'Europe/Athens',
  'GR': 'Europe/Athens',
  'Serbia': 'Europe/Belgrade',
  'RS': 'Europe/Belgrade',
  
  // Americas
  'United States': 'America/New_York',
  'USA': 'America/New_York',
  'US': 'America/New_York',
  'Canada': 'America/Toronto',
  'CA': 'America/Toronto',
  'Mexico': 'America/Mexico_City',
  'MX': 'America/Mexico_City',
  'Brazil': 'America/Sao_Paulo',
  'BR': 'America/Sao_Paulo',
  'Argentina': 'America/Argentina/Buenos_Aires',
  'AR': 'America/Argentina/Buenos_Aires',
  'Colombia': 'America/Bogota',
  'CO': 'America/Bogota',
  'Chile': 'America/Santiago',
  'CL': 'America/Santiago',
  'Peru': 'America/Lima',
  'PE': 'America/Lima',
  'Venezuela': 'America/Caracas',
  'VE': 'America/Caracas',
  
  // Africa
  'South Africa': 'Africa/Johannesburg',
  'ZA': 'Africa/Johannesburg',
  'Nigeria': 'Africa/Lagos',
  'NG': 'Africa/Lagos',
  'Kenya': 'Africa/Nairobi',
  'KE': 'Africa/Nairobi',
  'Egypt': 'Africa/Cairo',
  'EG': 'Africa/Cairo',
  'Morocco': 'Africa/Casablanca',
  'MA': 'Africa/Casablanca',
  
  // Oceania
  'Australia': 'Australia/Sydney',
  'AU': 'Australia/Sydney',
  'New Zealand': 'Pacific/Auckland',
  'NZ': 'Pacific/Auckland',
  
  // Middle East
  'UAE': 'Asia/Dubai',
  'AE': 'Asia/Dubai',
  'Saudi Arabia': 'Asia/Riyadh',
  'SA': 'Asia/Riyadh',
  'Israel': 'Asia/Jerusalem',
  'IL': 'Asia/Jerusalem',
  'Turkey': 'Europe/Istanbul',
  'TR': 'Europe/Istanbul',
};

// City to timezone mapping for more specific detection
const CITY_TIMEZONES: Record<string, string> = {
  // US Cities
  'New York': 'America/New_York',
  'Los Angeles': 'America/Los_Angeles',
  'Chicago': 'America/Chicago',
  'Houston': 'America/Chicago',
  'Phoenix': 'America/Phoenix',
  'San Francisco': 'America/Los_Angeles',
  'Seattle': 'America/Los_Angeles',
  'Denver': 'America/Denver',
  'Miami': 'America/New_York',
  'Boston': 'America/New_York',
  
  // Canadian Cities
  'Toronto': 'America/Toronto',
  'Vancouver': 'America/Vancouver',
  'Montreal': 'America/Montreal',
  'Calgary': 'America/Edmonton',
  
  // Australian Cities
  'Sydney': 'Australia/Sydney',
  'Melbourne': 'Australia/Melbourne',
  'Brisbane': 'Australia/Brisbane',
  'Perth': 'Australia/Perth',
  
  // Indian Cities
  'Mumbai': 'Asia/Kolkata',
  'Delhi': 'Asia/Kolkata',
  'Bangalore': 'Asia/Kolkata',
  'Chennai': 'Asia/Kolkata',
  'Hyderabad': 'Asia/Kolkata',
  
  // Philippine Cities
  'Manila': 'Asia/Manila',
  'Cebu': 'Asia/Manila',
  'Davao': 'Asia/Manila',
  
  // European Cities
  'London': 'Europe/London',
  'Paris': 'Europe/Paris',
  'Berlin': 'Europe/Berlin',
  'Amsterdam': 'Europe/Amsterdam',
  'Madrid': 'Europe/Madrid',
  'Rome': 'Europe/Rome',
  'Dublin': 'Europe/Dublin',
  'Lisbon': 'Europe/Lisbon',
  
  // Asian Cities
  'Tokyo': 'Asia/Tokyo',
  'Singapore': 'Asia/Singapore',
  'Hong Kong': 'Asia/Hong_Kong',
  'Bangkok': 'Asia/Bangkok',
  'Jakarta': 'Asia/Jakarta',
  'Seoul': 'Asia/Seoul',
  'Shanghai': 'Asia/Shanghai',
  'Beijing': 'Asia/Shanghai',
  'Dubai': 'Asia/Dubai',
};

/**
 * Detect timezone from a location string
 * Tries city first, then country
 */
export function detectTimezoneFromLocation(location: string): string | null {
  if (!location) return null;
  
  const normalizedLocation = location.trim();
  
  // Try exact city match first
  for (const [city, tz] of Object.entries(CITY_TIMEZONES)) {
    if (normalizedLocation.toLowerCase().includes(city.toLowerCase())) {
      console.log(`[TimezoneDetection] Detected timezone ${tz} from city: ${city}`);
      return tz;
    }
  }
  
  // Try country match
  for (const [country, tz] of Object.entries(COUNTRY_TIMEZONES)) {
    if (normalizedLocation.toLowerCase().includes(country.toLowerCase())) {
      console.log(`[TimezoneDetection] Detected timezone ${tz} from country: ${country}`);
      return tz;
    }
  }
  
  return null;
}

/**
 * Detect timezone from email domain
 * Some common country-specific email domains
 */
export function detectTimezoneFromEmail(email: string): string | null {
  if (!email) return null;
  
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  
  // Country-specific TLDs
  const TLD_TIMEZONES: Record<string, string> = {
    '.ph': 'Asia/Manila',
    '.in': 'Asia/Kolkata',
    '.pk': 'Asia/Karachi',
    '.bd': 'Asia/Dhaka',
    '.uk': 'Europe/London',
    '.de': 'Europe/Berlin',
    '.fr': 'Europe/Paris',
    '.nl': 'Europe/Amsterdam',
    '.au': 'Australia/Sydney',
    '.nz': 'Pacific/Auckland',
    '.jp': 'Asia/Tokyo',
    '.sg': 'Asia/Singapore',
    '.br': 'America/Sao_Paulo',
    '.mx': 'America/Mexico_City',
    '.za': 'Africa/Johannesburg',
  };
  
  for (const [tld, tz] of Object.entries(TLD_TIMEZONES)) {
    if (domain.endsWith(tld)) {
      console.log(`[TimezoneDetection] Detected timezone ${tz} from email TLD: ${tld}`);
      return tz;
    }
  }
  
  return null;
}

/**
 * Get timezone for a VA profile
 * Uses multiple detection methods with fallback
 */
export async function getVATimezone(vaId: number): Promise<string> {
  const db = await getDb();
  if (!db) return 'Asia/Manila'; // Default fallback
  
  try {
    const result = await db.execute(sql`
      SELECT timezone, email, name FROM va_profiles WHERE id = ${vaId}
    `);
    const rows = result.rows as Array<{
      timezone: string | null;
      email: string | null;
      name: string | null;
    }>;
    const profile = rows[0];
    
    if (!profile) {
      return 'Asia/Manila';
    }
    
    // If timezone is already set and not default, use it
    if (profile.timezone && profile.timezone !== 'Asia/Manila') {
      return profile.timezone;
    }
    
    // Try to detect from email
    if (profile.email) {
      const emailTz = detectTimezoneFromEmail(profile.email);
      if (emailTz) return emailTz;
    }
    
    // Try to detect from name (some names include location)
    if (profile.name) {
      const nameTz = detectTimezoneFromLocation(profile.name);
      if (nameTz) return nameTz;
    }
    
    // Return existing timezone or default
    return profile.timezone || 'Asia/Manila';
  } catch (error) {
    console.error('[TimezoneDetection] Error getting VA timezone:', error);
    return 'Asia/Manila';
  }
}

/**
 * Update VA profile timezone if detected
 */
export async function updateVATimezoneIfDetected(
  vaId: number,
  location?: string,
  email?: string
): Promise<string | null> {
  let detectedTz: string | null = null;
  
  // Try location first
  if (location) {
    detectedTz = detectTimezoneFromLocation(location);
  }
  
  // Try email if location didn't work
  if (!detectedTz && email) {
    detectedTz = detectTimezoneFromEmail(email);
  }
  
  if (!detectedTz) return null;
  
  const db = await getDb();
  if (!db) return null;
  
  try {
    await db.execute(sql`
      UPDATE va_profiles SET timezone = ${detectedTz} WHERE id = ${vaId}
    `);
    console.log(`[TimezoneDetection] Updated VA ${vaId} timezone to ${detectedTz}`);
    return detectedTz;
  } catch (error) {
    console.error('[TimezoneDetection] Error updating VA timezone:', error);
    return null;
  }
}

/**
 * Get all VAs with their timezones
 */
export async function getAllVATimezones(): Promise<Array<{
  id: number;
  name: string;
  timezone: string;
  detectedFrom?: string;
}>> {
  const db = await getDb();
  if (!db) return [];
  
  try {
    const result = await db.execute(sql`
      SELECT id, name, email, timezone FROM va_profiles WHERE status = 'active'
    `);
    const rows = result.rows as Array<{
      id: number;
      name: string;
      email: string | null;
      timezone: string | null;
    }>;
    
    return rows.map((row: any) => {
      let detectedFrom: string | undefined;
      let timezone = row.timezone || 'Asia/Manila';
      
      // Check if we can detect a better timezone
      if (row.email) {
        const emailTz = detectTimezoneFromEmail(row.email);
        if (emailTz && emailTz !== timezone) {
          detectedFrom = 'email';
        }
      }
      
      return {
        id: row.id,
        name: row.name,
        timezone,
        detectedFrom,
      };
    });
  } catch (error) {
    console.error('[TimezoneDetection] Error getting all VA timezones:', error);
    return [];
  }
}

/**
 * Convert a time to VA's local timezone
 */
export function convertToVATimezone(date: Date, timezone: string): Date {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    
    const parts = formatter.formatToParts(date);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value || '0';
    
    return new Date(
      parseInt(getPart('year')),
      parseInt(getPart('month')) - 1,
      parseInt(getPart('day')),
      parseInt(getPart('hour')),
      parseInt(getPart('minute')),
      parseInt(getPart('second'))
    );
  } catch (error) {
    console.error('[TimezoneDetection] Error converting timezone:', error);
    return date;
  }
}

/**
 * Check if current time is within VA's working hours
 */
export function isWithinWorkingHours(
  timezone: string,
  workStartHour: number,
  workEndHour: number
): boolean {
  const now = new Date();
  const localTime = convertToVATimezone(now, timezone);
  const currentHour = localTime.getHours();
  
  return currentHour >= workStartHour && currentHour < workEndHour;
}

export default {
  detectTimezoneFromLocation,
  detectTimezoneFromEmail,
  getVATimezone,
  updateVATimezoneIfDetected,
  getAllVATimezones,
  convertToVATimezone,
  isWithinWorkingHours,
};
