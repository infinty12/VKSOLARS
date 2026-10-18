/**
 * Mail transports. Server-only.
 *   smtp — nodemailer, loaded only when actually used; credentials stay inside this module.
 *   mock — writes each message as JSON into <test storage>/mail-outbox (tests only; refused by
 *          the config for any non-test STORAGE_DIR). MAIL_MOCK_FAIL=true simulates failures.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MailConfig } from './mail-config.ts';
import type { Transporter } from 'nodemailer';

export interface MailMessage {
  to: string[];
  from: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** An error whose message is safe to store/log: a short category only. */
export class MailSendError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(category);
    this.name = 'MailSendError';
    this.category = category;
  }
}

/** Map any transport error to a short, non-sensitive category. Never keep the raw message. */
export function categorizeMailError(err: unknown): string {
  if (err instanceof MailSendError) return err.category;
  const e = err as { code?: string; responseCode?: number };
  switch (e?.code) {
    case 'EAUTH':
      return 'auth_failed';
    case 'ECONNECTION':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
    case 'ENOTFOUND':
      return 'connection_failed';
    case 'ETLS':
      return 'tls_failed';
    case 'EENVELOPE':
    case 'EMESSAGE':
      return 'rejected';
  }
  if (typeof e?.responseCode === 'number' && e.responseCode >= 500) return 'rejected';
  if (typeof e?.responseCode === 'number' && e.responseCode >= 400) return 'temporary_failure';
  return 'send_failed';
}

/** Header values must never contain line breaks (header injection). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function createTransport(config: MailConfig): MailTransport {
  if (config.transport === 'mock') {
    const dir = resolve(config.mock.dir);
    return {
      async send(message) {
        if (config.mock.fail) throw new MailSendError('mock_failure');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ ...message, subject: oneLine(message.subject) }, null, 2));
      },
    };
  }

  let transporter: Transporter | null = null;
  const getTransporter = async (): Promise<Transporter> => {
    if (!transporter) {
      const nodemailer = (await import('nodemailer')).default;
      transporter = nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          requireTLS: !config.smtp.secure, // STARTTLS is mandatory when not using implicit TLS
          auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
          connectionTimeout: 15_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
        logger: false, // never let the library log message contents or credentials
        debug: false,
      });
    }
    return transporter;
  };
  return {
    async send(message) {
      const t = await getTransporter();
      await t.sendMail({
        from: config.from,
        to: message.to,
        subject: oneLine(message.subject),
        text: message.text,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
  };
}
