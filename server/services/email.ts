import sgMail from '@sendgrid/mail';
import { areNotificationsEnabled } from './notificationPolicy';

const EMAIL_NOTIFICATIONS_ENABLED = areNotificationsEnabled();

// Initialize SendGrid with API key
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  // Check global kill switch
  if (!EMAIL_NOTIFICATIONS_ENABLED) {
    console.log(`[Email] NOTIFICATIONS DISABLED - would have sent to ${options.to}: ${options.subject}`);
    return false;
  }
  
  if (!SENDGRID_API_KEY) {
    console.warn('SendGrid API key not configured, email not sent');
    return false;
  }

  try {
    await sgMail.send({
      to: options.to,
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@vadashboard.app',
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]*>/g, ''),
    });
    console.log(`Email sent to ${options.to}: ${options.subject}`);
    return true;
  } catch (error) {
    console.error('Failed to send email:', error);
    return false;
  }
}

interface Task {
  title: string;
  cardName: string;
  startTime?: string;
  endTime?: string;
  durationHours: number;
  priority: string;
}

interface WorkerBriefingData {
  workerName: string;
  date: string;
  tasks: Task[];
  totalHours: number;
  highPriorityCount: number;
}

export function generateMorningBriefingHtml(data: WorkerBriefingData): string {
  const taskRows = data.tasks.map(task => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #eee;">
        <strong>${task.title}</strong>
        <br><span style="color: #666; font-size: 12px;">${task.cardName}</span>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">
        ${task.startTime || 'TBD'} - ${task.endTime || 'TBD'}
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">
        ${task.durationHours}h
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">
        <span style="padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
          background: ${task.priority === 'critical' ? '#fee2e2' : task.priority === 'urgent' ? '#ffedd5' : task.priority === 'high' ? '#fef9c3' : '#f3f4f6'};
          color: ${task.priority === 'critical' ? '#dc2626' : task.priority === 'urgent' ? '#ea580c' : task.priority === 'high' ? '#ca8a04' : '#6b7280'};">
          ${task.priority.toUpperCase()}
        </span>
      </td>
    </tr>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">☀️ Good Morning, ${data.workerName}!</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${data.date}</p>
      </div>
      
      <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 12px 12px;">
        <div style="display: flex; gap: 20px; margin-bottom: 20px;">
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: #667eea;">${data.tasks.length}</div>
            <div style="color: #666; font-size: 12px;">Tasks Today</div>
          </div>
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: #667eea;">${data.totalHours}h</div>
            <div style="color: #666; font-size: 12px;">Total Hours</div>
          </div>
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: ${data.highPriorityCount > 0 ? '#dc2626' : '#667eea'};">${data.highPriorityCount}</div>
            <div style="color: #666; font-size: 12px;">High Priority</div>
          </div>
        </div>

        <h2 style="color: #333; font-size: 18px; margin: 20px 0 15px 0;">📋 Today's Schedule</h2>
        
        <table style="width: 100%; background: white; border-radius: 8px; border-collapse: collapse;">
          <thead>
            <tr style="background: #f3f4f6;">
              <th style="padding: 12px; text-align: left; font-weight: 600; color: #666;">Task</th>
              <th style="padding: 12px; text-align: center; font-weight: 600; color: #666;">Time</th>
              <th style="padding: 12px; text-align: center; font-weight: 600; color: #666;">Duration</th>
              <th style="padding: 12px; text-align: center; font-weight: 600; color: #666;">Priority</th>
            </tr>
          </thead>
          <tbody>
            ${taskRows || '<tr><td colspan="4" style="padding: 20px; text-align: center; color: #666;">No tasks scheduled for today</td></tr>'}
          </tbody>
        </table>

        <div style="margin-top: 20px; padding: 15px; background: #e0f2fe; border-radius: 8px;">
          <p style="margin: 0; color: #0369a1; font-size: 14px;">
            💡 <strong>Tip:</strong> Start with your highest priority tasks when your energy is at its peak!
          </p>
        </div>

        <div style="margin-top: 20px; text-align: center;">
          <a href="${process.env.APP_URL || 'https://vadashboard.app'}/worker" 
             style="display: inline-block; background: #667eea; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
            Open Dashboard →
          </a>
        </div>
      </div>

      <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
        <p>This is an automated briefing from VA Task Dashboard</p>
      </div>
    </body>
    </html>
  `;
}

interface EODReportData {
  workerName: string;
  date: string;
  completedTasks: Task[];
  incompleteTasks: Task[];
  blockedTasks: Task[];
  totalHoursWorked: number;
  completionRate: number;
}

export function generateEODReportHtml(data: EODReportData): string {
  const completedRows = data.completedTasks.map(task => `
    <li style="padding: 8px 0; border-bottom: 1px solid #eee;">
      ✅ <strong>${task.title}</strong> <span style="color: #666;">(${task.durationHours}h)</span>
    </li>
  `).join('');

  const incompleteRows = data.incompleteTasks.map(task => `
    <li style="padding: 8px 0; border-bottom: 1px solid #eee;">
      ⏳ <strong>${task.title}</strong> <span style="color: #666;">(${task.durationHours}h)</span>
    </li>
  `).join('');

  const blockedRows = data.blockedTasks.map(task => `
    <li style="padding: 8px 0; border-bottom: 1px solid #eee;">
      🚫 <strong>${task.title}</strong> <span style="color: #666;">(${task.durationHours}h)</span>
    </li>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">🌙 End of Day Report</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${data.workerName} • ${data.date}</p>
      </div>
      
      <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 12px 12px;">
        <div style="display: flex; gap: 20px; margin-bottom: 20px;">
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: #22c55e;">${data.completedTasks.length}</div>
            <div style="color: #666; font-size: 12px;">Completed</div>
          </div>
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: #f59e0b;">${data.incompleteTasks.length}</div>
            <div style="color: #666; font-size: 12px;">In Progress</div>
          </div>
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: #ef4444;">${data.blockedTasks.length}</div>
            <div style="color: #666; font-size: 12px;">Blocked</div>
          </div>
        </div>

        <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600;">Completion Rate</span>
            <span style="font-size: 24px; font-weight: bold; color: ${data.completionRate >= 80 ? '#22c55e' : data.completionRate >= 50 ? '#f59e0b' : '#ef4444'};">${data.completionRate}%</span>
          </div>
          <div style="background: #e5e7eb; height: 8px; border-radius: 4px; margin-top: 10px; overflow: hidden;">
            <div style="background: ${data.completionRate >= 80 ? '#22c55e' : data.completionRate >= 50 ? '#f59e0b' : '#ef4444'}; height: 100%; width: ${data.completionRate}%; border-radius: 4px;"></div>
          </div>
        </div>

        ${data.completedTasks.length > 0 ? `
          <h3 style="color: #22c55e; font-size: 16px; margin: 20px 0 10px 0;">✅ Completed Tasks</h3>
          <ul style="list-style: none; padding: 0; margin: 0; background: white; border-radius: 8px; padding: 10px 15px;">
            ${completedRows}
          </ul>
        ` : ''}

        ${data.incompleteTasks.length > 0 ? `
          <h3 style="color: #f59e0b; font-size: 16px; margin: 20px 0 10px 0;">⏳ In Progress</h3>
          <ul style="list-style: none; padding: 0; margin: 0; background: white; border-radius: 8px; padding: 10px 15px;">
            ${incompleteRows}
          </ul>
        ` : ''}

        ${data.blockedTasks.length > 0 ? `
          <h3 style="color: #ef4444; font-size: 16px; margin: 20px 0 10px 0;">🚫 Blocked</h3>
          <ul style="list-style: none; padding: 0; margin: 0; background: white; border-radius: 8px; padding: 10px 15px;">
            ${blockedRows}
          </ul>
        ` : ''}

        <div style="margin-top: 20px; padding: 15px; background: #fef3c7; border-radius: 8px;">
          <p style="margin: 0; color: #92400e; font-size: 14px;">
            ⏱️ <strong>Total Hours Logged:</strong> ${data.totalHoursWorked}h
          </p>
        </div>
      </div>

      <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
        <p>This is an automated report from VA Task Dashboard</p>
      </div>
    </body>
    </html>
  `;
}

export async function sendMorningBriefing(
  email: string,
  data: WorkerBriefingData
): Promise<boolean> {
  const html = generateMorningBriefingHtml(data);
  return sendEmail({
    to: email,
    subject: `☀️ Your Daily Briefing - ${data.date}`,
    html,
  });
}

export async function sendEODReport(
  email: string,
  data: EODReportData
): Promise<boolean> {
  const html = generateEODReportHtml(data);
  return sendEmail({
    to: email,
    subject: `🌙 End of Day Report - ${data.date}`,
    html,
  });
}

// Validate SendGrid API key by checking if it's configured
export async function validateSendGridApiKey(): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    return false;
  }
  // SendGrid doesn't have a simple validation endpoint, so we just check if the key is set
  // A real validation would require sending a test email
  return SENDGRID_API_KEY.startsWith('SG.');
}
