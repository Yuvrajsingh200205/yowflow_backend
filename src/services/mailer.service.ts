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
  await t.sendMail({ from: env.MAIL_FROM, ...message });
}

/** Test/dev hook: the most recent messages that were not delivered over SMTP. */
export const outbox: MailMessage[] = [];

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
    html: layout('Confirm your email', `Hi ${name}, confirm your email address to finish setting up your ${brand.name} workspace. This link expires in 48 hours.`, { label: 'Verify email', href: link }),
  };
}

export function passwordResetEmail(to: string, name: string, link: string): MailMessage {
  return {
    to,
    subject: `Reset your ${brand.name} password`,
    text: `Hi ${name},\n\nUse this link to choose a new password:\n${link}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.`,
    html: layout('Reset your password', `Hi ${name}, use the button below to choose a new password. This link expires in 1 hour.`, { label: 'Choose a new password', href: link }),
  };
}

export function portalInviteEmail(to: string, name: string, studioName: string, link: string): MailMessage {
  return {
    to,
    subject: `${studioName} invited you to your private portal`,
    text: `Hi ${name},\n\n${studioName} has set up a private portal for you — your wedding gallery, schedule and payments in one place.\n\nChoose a password to get started:\n${link}\n\nThis link expires in 7 days.`,
    html: layout('Your private portal is ready', `Hi ${name}, <strong>${studioName}</strong> has set up a private portal for you: your gallery, schedule and payment summary in one place. Choose a password to get started. This link expires in 7 days.`, { label: 'Open my portal', href: link }),
  };
}

export function portalResetEmail(to: string, name: string, link: string): MailMessage {
  return {
    to,
    subject: `Reset your ${brand.name} portal password`,
    text: `Hi ${name},\n\nUse this link to choose a new portal password:\n${link}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.`,
    html: layout('Reset your password', `Hi ${name}, use the button below to choose a new password for your portal. This link expires in 1 hour.`, { label: 'Choose a new password', href: link }),
  };
}
