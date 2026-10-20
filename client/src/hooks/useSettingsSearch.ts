import { useMemo } from 'react';
import { SearchResult } from '@/components/SettingsSearch';

// Define all searchable settings
const SEARCHABLE_SETTINGS: SearchResult[] = [
  // Integration & Automation Section
  {
    section: 'Integration & Automation',
    tab: 'Trello Chatbot',
    title: 'Trello Chatbot',
    description: 'Configure Trello chatbot settings and webhooks',
    category: 'tab',
  },
  {
    section: 'Integration & Automation',
    tab: 'Trello Chatbot',
    title: 'Trello Chatbot Configuration',
    description: 'Configure Trello chatbot settings and webhooks',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'Trello Chatbot',
    title: 'Webhook Setup',
    description: 'Set up and manage Trello webhook endpoints',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'Trello Chatbot',
    title: 'Test Webhook',
    description: 'Test webhook connectivity and response',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'Trello Chatbot',
    title: 'Analytics',
    description: 'View chatbot usage and performance analytics',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'Notifications',
    title: 'Notifications',
    description: 'Configure notification preferences',
    category: 'tab',
  },
  {
    section: 'Integration & Automation',
    tab: 'Notifications',
    title: 'Notification Settings',
    description: 'Configure notification preferences',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'Notifications',
    title: 'Email Notifications',
    description: 'Enable or disable email notifications',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'Notifications',
    title: 'Task Alerts',
    description: 'Configure task-related alerts',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'AI & Models',
    title: 'AI & Models',
    description: 'Select and configure AI models',
    category: 'tab',
  },
  {
    section: 'Integration & Automation',
    tab: 'AI & Models',
    title: 'AI Provider Settings',
    description: 'View the server-managed OpenAI connection and active model',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'AI & Models',
    title: 'Model Selection',
    description: 'View the model selected from the OpenAI account catalog',
    category: 'setting',
  },
  {
    section: 'Integration & Automation',
    tab: 'AI & Models',
    title: 'API Key Status',
    description: 'Confirm that the server-managed OpenAI key is connected',
    category: 'setting',
  },

  // Scheduling & Time Section
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Working Hours',
    description: 'Set your working hours schedule',
    category: 'tab',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Work Start Time',
    description: 'Set when your work day begins',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Work End Time',
    description: 'Set when your work day ends',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Total Hours',
    description: 'View calculated total working hours',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Working Days',
    description: 'Select which days you work',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Time Zone',
    description: 'Set your time zone for scheduling',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Meal Times',
    description: 'Configure meal breaks and times',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Breakfast Time',
    description: 'Configure breakfast break time and duration',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Lunch Time',
    description: 'Configure lunch break time and duration',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Dinner Time',
    description: 'Configure dinner break time and duration',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Short Breaks',
    description: 'Configure short break intervals and duration',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Long Breaks',
    description: 'Configure long break intervals and duration',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Weekly Hours Limits',
    description: 'Set minimum and maximum weekly working hours',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Daily Hours Limits',
    description: 'Set minimum and maximum daily working hours',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Working Hours',
    title: 'Break Settings',
    description: 'Configure short and long break intervals',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Holidays & Days Off',
    title: 'Holidays & Days Off',
    description: 'Manage holidays and days off',
    category: 'tab',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Holidays & Days Off',
    title: 'Holiday Management',
    description: 'Manage holidays and days off',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Holidays & Days Off',
    title: 'Add Holiday',
    description: 'Add new holidays to your calendar',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Holidays & Days Off',
    title: 'Country Selection',
    description: 'Select country for holiday calendar',
    category: 'setting',
  },
  {
    section: 'Scheduling & Time',
    tab: 'Holidays & Days Off',
    title: 'Employee Selection',
    description: 'Select employee to manage their schedule',
    category: 'setting',
  },

  // Performance & Monitoring Section
  {
    section: 'Performance & Monitoring',
    tab: 'System Health',
    title: 'System Health',
    description: 'Monitor overall system health and status',
    category: 'tab',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'System Health',
    title: 'Overall System Health',
    description: 'Monitor overall system health and status',
    category: 'setting',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'System Health',
    title: 'Health Recommendations',
    description: 'View system health recommendations',
    category: 'setting',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'Cache Performance',
    title: 'Cache Performance',
    description: 'Monitor cache performance metrics',
    category: 'tab',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'Cache Performance',
    title: 'Cache Statistics',
    description: 'View database cache performance metrics',
    category: 'setting',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'Cache Performance',
    title: 'Cache Hit Rate',
    description: 'Monitor cache hit rate and efficiency',
    category: 'setting',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'Cache Performance',
    title: 'Clear Cache',
    description: 'Manually clear the cache to reset metrics',
    category: 'setting',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'Request Queue',
    title: 'Request Queue',
    description: 'Monitor request queue performance',
    category: 'tab',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'Request Queue',
    title: 'Queue Statistics',
    description: 'View request queue performance',
    category: 'setting',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'Request Queue',
    title: 'Deduplication Stats',
    description: 'Monitor request deduplication metrics',
    category: 'setting',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'WebSocket Status',
    title: 'WebSocket Status',
    description: 'Monitor real-time WebSocket connections',
    category: 'tab',
  },
  {
    section: 'Performance & Monitoring',
    tab: 'WebSocket Status',
    title: 'WebSocket Connections',
    description: 'Monitor real-time WebSocket connections',
    category: 'setting',
  },
  {
    section: 'Maintenance',
    tab: 'Maintenance',
    title: 'Maintenance runs',
    description: 'Configure intervals, run jobs, and inspect live progress and ETA',
    category: 'tab',
  },
  {
    section: 'Maintenance',
    tab: 'Maintenance',
    title: 'Evidence and compliance jobs',
    description: 'Configure Google, Trello, compliance, weekly analysis, APTLSS, webhook, and database maintenance',
    category: 'setting',
  },
];

export function useSettingsSearch(query: string): SearchResult[] {
  return useMemo(() => {
    if (!query.trim()) return [];

    const normalizedQuery = query.toLowerCase();

    return SEARCHABLE_SETTINGS.filter((setting) => {
      const searchableText = [
        setting.title,
        setting.description,
        setting.tab,
        setting.section,
      ]
        .join(' ')
        .toLowerCase();

      return searchableText.includes(normalizedQuery);
    }).sort((a, b) => {
      // Prioritize exact matches in title
      const aTitle = a.title.toLowerCase();
      const bTitle = b.title.toLowerCase();

      if (aTitle.includes(normalizedQuery) && !bTitle.includes(normalizedQuery)) {
        return -1;
      }
      if (!aTitle.includes(normalizedQuery) && bTitle.includes(normalizedQuery)) {
        return 1;
      }

      // Then prioritize tabs over settings
      if (a.category === 'tab' && b.category !== 'tab') {
        return -1;
      }
      if (a.category !== 'tab' && b.category === 'tab') {
        return 1;
      }

      return 0;
    });
  }, [query]);
}
