import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { brand } from '../config/brand';
import { logger } from '../config/logger';

let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  transporter = env.SMTP_HOST
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      })
    : null;
  return transporter;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Replies go to the studio rather than to the platform's no-reply address. */
  replyTo?: string | null;
  /** Shown as the sender's display name (for example the studio's name). */
  fromName?: string | null;
}

/**
 * Sends a transactional e-mail. In production a missing SMTP configuration is a
 * hard error (silently dropping a password-reset mail is worse than failing).
 * In development and tests the message is logged, including its text body, so
 * the flow can be exercised without an SMTP server.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const t = getTransporter();
  if (!t) {
    if (env.isProduction) throw new Error('SMTP is not configured: set SMTP_HOST (and credentials) to send e-mail.');
    if (!env.isTest) logger.info({ to: message.to, subject: message.subject, body: message.text }, 'mail (dev, not sent)');
    outbox.push(message);
    return;
  }
  const { fromName, replyTo, ...rest } = message;
  await t.sendMail({ ...rest, from: fromName ? displayFrom(fromName) : env.MAIL_FROM, ...(replyTo ? { replyTo } : {}) });
}

/** Test/dev hook: the most recent messages that were not delivered over SMTP. */
export const outbox: MailMessage[] = [];

/** `Studio Name <no-reply@…>` built from the configured sender address. */
function displayFrom(name: string): string {
  const address = /<([^>]+)>/.exec(env.MAIL_FROM)?.[1] ?? env.MAIL_FROM;
  return `"${name.replace(/["\\\r\n<>]/g, '').slice(0, 80)}" <${address}>`;
}

/** Escapes text that ends up inside e-mail HTML. Names and messages come from forms, so they are never trusted. */
export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`;
const fmtDate = (d?: Date | string | null) => (d ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(d)) : '—');

const layout = (title: string, body: string, cta: { label: string; href: string }) => `<!doctype html>
<html><body style="margin:0;background:#f6f7f3;font-family:Inter,Arial,sans-serif;color:#0e130c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e8ebdf;border-radius:16px">
<tr><td style="padding:32px">
<p style="margin:0 0 24px;font-size:18px;font-weight:700">${brand.name}</p>
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25">${title}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475043">${body}</p>
<a href="${cta.href}" style="display:inline-block;background:#b4f03c;color:#0b1006;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">${cta.label}</a>
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#626c5e">If the button does not work, paste this link into your browser:<br>${cta.href}</p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#626c5e">If you did not request this, you can ignore this email.</p>
</td></tr></table></body></html>`;

export function verificationEmail(to: string, name: string, link: string): MailMessage {
  return {
    to,
    subject: `Verify your email for ${brand.name}`,
    text: `Hi ${name},\n\nConfirm your email address to finish setting up ${brand.name}:\n${link}\n\nThis link expires in 48 hours.`,
    html: layout('Confirm your email', `Hi ${esc(name)}, confirm your email address to finish setting up your ${brand.name} workspace. This link expires in 48 hours.`, { label: 'Verify email', href: link }),
  };
}

export function passwordResetEmail(to: string, name: string, link: string): MailMessage {
  return {
    to,
    subject: `Reset your ${brand.name} password`,
    text: `Hi ${name},\n\nUse this link to choose a new password:\n${link}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.`,
    html: layout('Reset your password', `Hi ${esc(name)}, use the button below to choose a new password. This link expires in 1 hour.`, { label: 'Choose a new password', href: link }),
  };
}

export function portalInviteEmail(to: string, name: string, studioName: string, link: string): MailMessage {
  return {
    to,
    subject: `${studioName} invited you to your private portal`,
    text: `Hi ${name},\n\n${studioName} has set up a private portal for you — your wedding gallery, schedule and payments in one place.\n\nChoose a password to get started:\n${link}\n\nThis link expires in 7 days.`,
    html: layout('Your private portal is ready', `Hi ${esc(name)}, <strong>${esc(studioName)}</strong> has set up a private portal for you: your gallery, schedule and payment summary in one place. Choose a password to get started. This link expires in 7 days.`, { label: 'Open my portal', href: link }),
  };
}

export function portalResetEmail(to: string, name: string, link: string): MailMessage {
  return {
    to,
    subject: `Reset your ${brand.name} portal password`,
    text: `Hi ${name},\n\nUse this link to choose a new portal password:\n${link}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.`,
    html: layout('Reset your password', `Hi ${esc(name)}, use the button below to choose a new password for your portal. This link expires in 1 hour.`, { label: 'Choose a new password', href: link }),
  };
}


// ── Quotes, enquiries and reminders ─────────────────────────────────────────
const rows = (items: Array<[string, string]>) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 4px;width:100%">${items.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#626c5e;font-size:13px">${esc(k)}</td><td style="padding:3px 0;font-weight:600;font-size:14px">${esc(v)}</td></tr>`).join('')}</table>`;

export function quoteEmail(a: { to: string; name: string; studioName: string; link: string; total: number; validUntil?: Date | null; eventDate?: Date | null; studioPhone?: string | null; replyTo?: string | null }): MailMessage {
  const first = a.name.split(' ')[0] || 'there';
  return {
    to: a.to, replyTo: a.replyTo, fromName: a.studioName,
    subject: `Your quotation from ${a.studioName}`,
    text: `Hi ${first},\n\nThank you for your enquiry with ${a.studioName}. Your quotation (${inr(a.total)}) is ready:\n${a.link}\n\n${a.validUntil ? `It is valid until ${fmtDate(a.validUntil)}.\n` : ''}${a.studioPhone ? `Questions? Call ${a.studioPhone}.` : ''}`,
    html: layout(`Your quotation is ready`, `Hi ${esc(first)}, thank you for your enquiry with <strong>${esc(a.studioName)}</strong>. We have prepared a quotation for you.<br><br>${rows([['Estimate', inr(a.total)], ['Event date', fmtDate(a.eventDate)], ['Valid until', fmtDate(a.validUntil)]])}`, { label: 'View quotation', href: a.link }),
  };
}

export function quoteAcceptedStaffEmail(a: { to: string; customerName: string; quoteNumber: string; total: number; eventDate?: Date | null; link: string }): MailMessage {
  return {
    to: a.to,
    subject: `Booked: ${a.customerName} accepted ${a.quoteNumber}`,
    text: `${a.customerName} accepted quotation ${a.quoteNumber} (${inr(a.total)}) for ${fmtDate(a.eventDate)}. A project and payment schedule were created.\n${a.link}`,
    html: layout('A quotation was accepted', `<strong>${esc(a.customerName)}</strong> accepted <strong>${esc(a.quoteNumber)}</strong>. A project, client record and payment schedule were created for you.<br><br>${rows([['Total', inr(a.total)], ['Event date', fmtDate(a.eventDate)]])}`, { label: 'Open quotes', href: a.link }),
  };
}

export function newEnquiryStaffEmail(a: { to: string; name: string; phone: string; eventType?: string | null; eventDate?: Date | null; quoteNote: string; link: string }): MailMessage {
  return {
    to: a.to,
    subject: `New enquiry: ${a.name}`,
    text: `${a.name} (${a.phone}) enquired about ${a.eventType ?? 'an event'} on ${fmtDate(a.eventDate)}.\n${a.quoteNote}\n${a.link}`,
    html: layout('New enquiry from your booking page', `<strong>${esc(a.name)}</strong> sent an enquiry.<br><br>${rows([['Phone', a.phone], ['Event', (a.eventType ?? 'Event').replace(/_/g, ' ').toLowerCase()], ['Date', fmtDate(a.eventDate)]])}<br>${esc(a.quoteNote)}`, { label: 'Open leads', href: a.link }),
  };
}

export function paymentReminderEmail(a: { to: string; name: string; studioName: string; title: string; amount: number; dueDate: Date; overdue: boolean; projectName?: string | null; upiId?: string | null; replyTo?: string | null }): MailMessage {
  const first = a.name.split(' ')[0] || 'there';
  const when = a.overdue ? `was due on ${fmtDate(a.dueDate)}` : `is due on ${fmtDate(a.dueDate)}`;
  return {
    to: a.to, replyTo: a.replyTo, fromName: a.studioName,
    subject: a.overdue ? `Payment overdue: ${a.title} (${inr(a.amount)})` : `Payment reminder: ${a.title} (${inr(a.amount)})`,
    text: `Hi ${first},\n\nA gentle reminder from ${a.studioName}: your ${a.title.toLowerCase()} payment of ${inr(a.amount)} ${when}.${a.upiId ? `\nYou can pay by UPI to ${a.upiId}.` : ''}\n\nIf you have already paid, please ignore this message.`,
    html: layout(a.overdue ? 'A payment is overdue' : 'A payment is coming up', `Hi ${esc(first)}, a gentle reminder from <strong>${esc(a.studioName)}</strong>.<br><br>${rows([['For', a.projectName ?? a.title], ['Payment', a.title], ['Amount', inr(a.amount)], ['Due', fmtDate(a.dueDate)]])}${a.upiId ? `<br>Pay by UPI to <strong>${esc(a.upiId)}</strong>.` : ''}<br><br>If you have already paid, please ignore this message.`, { label: 'Contact the studio', href: a.replyTo ? `mailto:${a.replyTo}` : 'mailto:' }),
  };
}

export function quoteNudgeEmail(a: { to: string; name: string; studioName: string; link: string; kind: 'NOT_OPENED' | 'EXPIRING'; validUntil?: Date | null; replyTo?: string | null }): MailMessage {
  const first = a.name.split(' ')[0] || 'there';
  const lead = a.kind === 'EXPIRING' ? `Your quotation expires on ${fmtDate(a.validUntil)}.` : 'Just checking that you received our quotation.';
  return {
    to: a.to, replyTo: a.replyTo, fromName: a.studioName,
    subject: a.kind === 'EXPIRING' ? `Your quotation from ${a.studioName} expires soon` : `Your quotation from ${a.studioName}`,
    text: `Hi ${first},\n\n${lead}\n${a.link}\n\nDates fill up quickly, so confirm early to secure yours.`,
    html: layout(a.kind === 'EXPIRING' ? 'Your quotation expires soon' : 'Your quotation is waiting', `Hi ${esc(first)}, ${esc(lead)} Dates fill up quickly, so confirm early to secure yours.`, { label: 'View quotation', href: a.link }),
  };
}
