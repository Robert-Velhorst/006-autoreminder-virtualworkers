import { convert } from 'html-to-text';
import { areNotificationsEnabled } from './notificationPolicy';
import nodemailer, { type Transporter } from 'nodemailer';
import { ScheduledJobLeaseLostError, type ScheduledJobContext } from '../scheduledJobRuntime';
import { assertEmailDispatchAllowed, EmailDispatchNotStartedError } from './email-dispatch-guard';
import {
  getGoogleMailDeliveryStatus,
  sendGoogleMail,
  validateGoogleMailDeliveryConnection,
} from '../googleEvidence';

// Delivery must be explicitly enabled. Running in production alone must never
// make the application send email with an unverified sender configuration.
const EMAIL_NOTIFICATIONS_ENABLED = areNotificationsEnabled();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL?.trim();
const GMAIL_SMTP_USER = process.env.GMAIL_SMTP_USER?.trim();
const GMAIL_SMTP_APP_PASSWORD = process.env.GMAIL_SMTP_APP_PASSWORD?.trim();
const GMAIL_SMTP_HOST = process.env.GMAIL_SMTP_HOST?.trim() || 'smtp.gmail.com';
const GMAIL_SMTP_PORT = Number(process.env.GMAIL_SMTP_PORT || '465');
const GMAIL_SMTP_SECURE = process.env.GMAIL_SMTP_SECURE
  ? process.env.GMAIL_SMTP_SECURE === 'true'
  : GMAIL_SMTP_PORT === 465;

type EmailProvider = 'gmail_api' | 'sendgrid' | 'gmail_smtp';

interface EmailProviderStatus {
  provider: EmailProvider | null;
  enabled: boolean;
  ready: boolean;
  reason?: string;
}

export type EmailDeliveryOutcome =
  | { status: 'sent' }
  | { status: 'not_sent'; reason: string }
  | { status: 'uncertain'; reason: string };

let gmailTransporter: Transporter | null = null;

export async function getEmailProviderStatus(): Promise<EmailProviderStatus> {
  if (!EMAIL_NOTIFICATIONS_ENABLED) {
    return {
      provider: null,
      enabled: false,
      ready: false,
      reason: 'Email notifications are disabled',
    };
  }

  const configuredProvider = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  const provider = configuredProvider === 'gmail_api'
    ? 'gmail_api'
    : configuredProvider === 'gmail_smtp' || configuredProvider === 'gmail'
      ? 'gmail_smtp'
      : configuredProvider === 'sendgrid'
        ? 'sendgrid'
        : (await getGoogleMailDeliveryStatus()).connected
          ? 'gmail_api'
          : SENDGRID_API_KEY || SENDGRID_FROM_EMAIL
            ? 'sendgrid'
            : GMAIL_SMTP_USER || GMAIL_SMTP_APP_PASSWORD
              ? 'gmail_smtp'
              : null;

  if (!provider) {
    return {
      provider: null,
      enabled: true,
      ready: false,
      reason: 'No email provider is configured',
    };
  }

  if (provider === 'gmail_api') {
    const status = await getGoogleMailDeliveryStatus();
    if (!status.connected) {
      return {
        provider,
        enabled: true,
        ready: false,
        reason: status.setupMessage ?? 'Gmail API delivery is not connected',
      };
    }
    return { provider, enabled: true, ready: true };
  }

  if (provider === 'sendgrid') {
    if (!SENDGRID_API_KEY || !SENDGRID_FROM_EMAIL) {
      return {
        provider,
        enabled: true,
        ready: false,
        reason: 'SendGrid requires an API key and verified sender address',
      };
    }
    return { provider, enabled: true, ready: true };
  }

  if (!GMAIL_SMTP_USER || !GMAIL_SMTP_APP_PASSWORD) {
    return {
      provider,
      enabled: true,
      ready: false,
      reason: 'Gmail SMTP requires an account and an app password',
    };
  }

  if (!Number.isInteger(GMAIL_SMTP_PORT) || GMAIL_SMTP_PORT < 1 || GMAIL_SMTP_PORT > 65535) {
    return {
      provider,
      enabled: true,
      ready: false,
      reason: 'Gmail SMTP port must be between 1 and 65535',
    };
  }

  return { provider, enabled: true, ready: true };
}

function getGmailTransporter(): Transporter {
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      host: GMAIL_SMTP_HOST,
      port: GMAIL_SMTP_PORT,
      secure: GMAIL_SMTP_SECURE,
      auth: {
        user: GMAIL_SMTP_USER!,
        pass: GMAIL_SMTP_APP_PASSWORD!,
      },
    });
  }
  return gmailTransporter;
}

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Preserve the SDK's bare-address and "Name <address>" string forms without
// exposing a separate sending API or accepting arbitrary provider options.
function sendGridAddress(value: string) {
  if (typeof value !== 'string') throw new Error('Invalid email address');
  const bracket = value.indexOf('<');
  if (bracket < 0) return { email: value };
  return { name: value.slice(0, bracket).trim(), email: value.slice(bracket + 1).replace('>', '').trim() };
}

function escapeEmailHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

function escapeEmailUrl(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Email links require an HTTP(S) URL without credentials');
  }
  return escapeEmailHtml(url.href);
}

async function assertEmailOwnership(context?: ScheduledJobContext): Promise<void> {
  if (!context) return;
  if (context.signal.aborted) throw new ScheduledJobLeaseLostError();
  await context.assertOwnership();
  if (context.signal.aborted) throw new ScheduledJobLeaseLostError();
}

export async function sendEmailWithOutcome(
  options: EmailOptions,
  context?: ScheduledJobContext,
  beforeDispatch?: () => Promise<boolean>,
): Promise<EmailDeliveryOutcome> {
  let status: EmailProviderStatus;
  try {
    await assertEmailOwnership(context);
    status = await getEmailProviderStatus();
    await assertEmailOwnership(context);
  } catch (error) {
    if (error instanceof ScheduledJobLeaseLostError) throw error;
    console.error('[Email] Provider readiness could not be checked; no send was attempted.');
    return { status: 'not_sent', reason: 'Email provider readiness could not be checked; no email was sent.' };
  }

  if (!status.ready || !status.provider) {
    console.log('[Email] Not sent: %s', status.reason);
    return { status: 'not_sent', reason: `${status.reason ?? 'Email provider is not ready'}; no email was sent.` };
  }

  let dispatchStarted = false;
  try {
    const text = options.text || convert(options.html, {
      wordwrap: false,
      selectors: [
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'img', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
      ],
    });
    if (status.provider === 'gmail_api') {
      const message = { to: options.to, subject: options.subject, html: options.html, text };
      await assertEmailOwnership(context);
      // Gmail performs the final guard after its own token refresh and MIME composition.
      if (beforeDispatch) await sendGoogleMail(message, context, beforeDispatch);
      else if (context) await sendGoogleMail(message, context);
      else await sendGoogleMail(message);
    } else if (status.provider === 'sendgrid') {
      const subject = options.subject;
      const html = options.html;
      if (typeof subject !== 'string' || typeof html !== 'string' || typeof text !== 'string') {
        throw new Error('Invalid email content');
      }
      const body = JSON.stringify({
        personalizations: [{ to: [sendGridAddress(options.to)] }],
        from: sendGridAddress(SENDGRID_FROM_EMAIL!),
        subject,
        content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
      });
      const deadline = AbortSignal.timeout(15_000);
      const signal = context ? AbortSignal.any([deadline, context.signal]) : deadline;
      await assertEmailOwnership(context);
      await assertEmailDispatchAllowed(beforeDispatch, context);
      if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
      dispatchStarted = true;
      try {
        const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
          body,
          signal,
          redirect: 'error',
        });
        // Never ingest provider-controlled bodies or leak request credentials.
        void response.body?.cancel().catch(() => undefined);
        if (response.status !== 202) throw new Error('SendGrid did not accept the message');
      } catch {
        throw new Error('SendGrid did not confirm message acceptance');
      }
    } else {
      const transporter = getGmailTransporter();
      const message = {
        to: options.to,
        from: GMAIL_SMTP_USER!,
        subject: options.subject,
        html: options.html,
        text,
      };
      await assertEmailOwnership(context);
      await assertEmailDispatchAllowed(beforeDispatch, context);
      if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
      dispatchStarted = true;
      await transporter.sendMail(message);
    }
    console.log(`[Email] ${status.provider} delivery succeeded: ${options.subject}`);
    return { status: 'sent' };
  } catch (error) {
    if (error instanceof ScheduledJobLeaseLostError) throw error;
    if (!dispatchStarted && error instanceof EmailDispatchNotStartedError) {
      return { status: 'not_sent', reason: error.message };
    }
    console.error(`[Email] ${status.provider} delivery failed:`, error);
    return {
      status: 'uncertain',
      reason: 'The provider did not confirm delivery. Verify the destination before authorizing a retry.',
    };
  }
}

export async function sendEmail(options: EmailOptions, context?: ScheduledJobContext, beforeDispatch?: () => Promise<boolean>): Promise<boolean> {
  const outcome = beforeDispatch ? await sendEmailWithOutcome(options, context, beforeDispatch)
    : context ? await sendEmailWithOutcome(options, context) : await sendEmailWithOutcome(options);
  return outcome.status === 'sent';
}

export async function sendWorkerInvitationEmail({
  email,
  workerName,
  inviteUrl,
  expiresAt,
}: {
  email: string;
  workerName: string;
  inviteUrl: string;
  expiresAt: Date;
}) {
  const safeName = escapeEmailHtml(workerName);
  const safeUrl = escapeEmailUrl(inviteUrl);
  const expiry = expiresAt.toISOString();
  return sendEmail({
    to: email,
    subject: "Set up your Virtual Worker account",
    text: `Hello ${workerName},\n\nUse this one-time link to set up your Virtual Worker account: ${inviteUrl}\n\nThe link expires at ${expiry}.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827">
      <h1 style="font-size:22px;margin:0 0 16px">Set up your worker account</h1>
      <p>Hello ${safeName},</p>
      <p>You have been invited to the Virtual Worker dashboard. Choose your own password, then connect your work evidence sources from the protected settings page.</p>
      <p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:600">Accept invitation</a></p>
      <p style="font-size:13px;color:#6b7280">This one-time link expires at ${escapeEmailHtml(expiry)}. If you were not expecting this invitation, ignore this email.</p>
    </div>`,
  });
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
  const dashboardUrl = escapeEmailUrl(`${process.env.APP_URL || 'https://vadashboard.app'}/worker`);
  const taskRows = data.tasks.map(task => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #eee;">
        <strong>${escapeEmailHtml(String(task.title))}</strong>
        <br><span style="color: #666; font-size: 12px;">${escapeEmailHtml(String(task.cardName))}</span>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">
        ${escapeEmailHtml(String(task.startTime || 'TBD'))} - ${escapeEmailHtml(String(task.endTime || 'TBD'))}
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">
        ${escapeEmailHtml(String(task.durationHours))}h
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">
        <span style="padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
          background: ${task.priority === 'critical' ? '#fee2e2' : task.priority === 'urgent' ? '#ffedd5' : task.priority === 'high' ? '#fef9c3' : '#f3f4f6'};
          color: ${task.priority === 'critical' ? '#dc2626' : task.priority === 'urgent' ? '#ea580c' : task.priority === 'high' ? '#ca8a04' : '#6b7280'};">
          ${escapeEmailHtml(String(task.priority).toUpperCase())}
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
        <h1 style="color: white; margin: 0; font-size: 24px;">☀️ Good Morning, ${escapeEmailHtml(String(data.workerName))}!</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${escapeEmailHtml(String(data.date))}</p>
      </div>
      
      <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 12px 12px;">
        <div style="display: flex; gap: 20px; margin-bottom: 20px;">
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: #667eea;">${data.tasks.length}</div>
            <div style="color: #666; font-size: 12px;">Tasks Today</div>
          </div>
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: #667eea;">${escapeEmailHtml(String(data.totalHours))}h</div>
            <div style="color: #666; font-size: 12px;">Total Hours</div>
          </div>
          <div style="flex: 1; background: white; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: ${data.highPriorityCount > 0 ? '#dc2626' : '#667eea'};">${escapeEmailHtml(String(data.highPriorityCount))}</div>
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
          <a href="${dashboardUrl}"
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
  const completionRate = typeof data.completionRate === 'number' && Number.isFinite(data.completionRate)
    ? Math.min(100, Math.max(0, data.completionRate)) : 0;
  const completedRows = data.completedTasks.map(task => `
    <li style="padding: 8px 0; border-bottom: 1px solid #eee;">
      ✅ <strong>${escapeEmailHtml(String(task.title))}</strong> <span style="color: #666;">(${escapeEmailHtml(String(task.durationHours))}h)</span>
    </li>
  `).join('');

  const incompleteRows = data.incompleteTasks.map(task => `
    <li style="padding: 8px 0; border-bottom: 1px solid #eee;">
      ⏳ <strong>${escapeEmailHtml(String(task.title))}</strong> <span style="color: #666;">(${escapeEmailHtml(String(task.durationHours))}h)</span>
    </li>
  `).join('');

  const blockedRows = data.blockedTasks.map(task => `
    <li style="padding: 8px 0; border-bottom: 1px solid #eee;">
      🚫 <strong>${escapeEmailHtml(String(task.title))}</strong> <span style="color: #666;">(${escapeEmailHtml(String(task.durationHours))}h)</span>
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
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">${escapeEmailHtml(String(data.workerName))} • ${escapeEmailHtml(String(data.date))}</p>
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
            <span style="font-size: 24px; font-weight: bold; color: ${completionRate >= 80 ? '#22c55e' : completionRate >= 50 ? '#f59e0b' : '#ef4444'};">${completionRate}%</span>
          </div>
          <div style="background: #e5e7eb; height: 8px; border-radius: 4px; margin-top: 10px; overflow: hidden;">
            <div style="background: ${completionRate >= 80 ? '#22c55e' : completionRate >= 50 ? '#f59e0b' : '#ef4444'}; height: 100%; width: ${completionRate}%; border-radius: 4px;"></div>
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
            ⏱️ <strong>Total Hours Logged:</strong> ${escapeEmailHtml(String(data.totalHoursWorked))}h
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
  data: WorkerBriefingData,
  context?: ScheduledJobContext,
  beforeDispatch?: () => Promise<boolean>,
): Promise<boolean> {
  const html = generateMorningBriefingHtml(data);
  const message = {
    to: email,
    subject: `☀️ Your Daily Briefing - ${data.date}`,
    html,
  };
  if (beforeDispatch) return sendEmail(message, context, beforeDispatch);
  return context ? sendEmail(message, context) : sendEmail(message);
}

export async function sendEODReport(
  email: string,
  data: EODReportData,
  context?: ScheduledJobContext,
  beforeDispatch?: () => Promise<boolean>,
): Promise<boolean> {
  const html = generateEODReportHtml(data);
  const message = {
    to: email,
    subject: `🌙 End of Day Report - ${data.date}`,
    html,
  };
  if (beforeDispatch) return sendEmail(message, context, beforeDispatch);
  return context ? sendEmail(message, context) : sendEmail(message);
}

export async function validateEmailProvider(): Promise<boolean> {
  const status = await getEmailProviderStatus();
  if (!status.ready || !status.provider) {
    return false;
  }

  if (status.provider === 'gmail_api') {
    return validateGoogleMailDeliveryConnection();
  }

  if (status.provider === 'gmail_smtp') {
    try {
      await getGmailTransporter().verify();
      return true;
    } catch (error) {
      console.error('[Email] Gmail SMTP verification failed:', error);
      return false;
    }
  }

  return SENDGRID_API_KEY?.startsWith('SG.') ?? false;
}

// Backward-compatible SendGrid-specific check for existing callers.
export async function validateSendGridApiKey(): Promise<boolean> {
  const status = await getEmailProviderStatus();
  return status.provider === 'sendgrid' && status.ready && (SENDGRID_API_KEY?.startsWith('SG.') ?? false);
}
