// notifications.ts — multichannel notifications for PRISM apps.
//
// The app-developer counterpart to the Rust Mailer capability, generalised to
// many channels: one `notify(recipient, notification)` fans a message out to
// email, SMS, Slack, an in-app feed (via the ORM), or a webhook — each channel
// rendered from the same Notification via a `toMail`/`toSms`/… method. Modelled
// on Laravel's Notification + Channels.
//
//   const notifier = createNotifier([
//     mailChannel({ appId: "my-site" }),
//     smsChannel({ send: twilioSend }),        // bext has no SMS provider — inject one
//     databaseChannel({ model: Notifications }) // composes @bext-stack/framework/orm
//   ]);
//
//   const InvoicePaid: Notification<User> = {
//     via: () => ["mail", "database"],
//     toMail: (u) => ({ subject: "Paid", html: `<p>Thanks ${u.name}</p>` }),
//     toDatabase: (u) => ({ type: "invoice.paid", user_id: u.id, read: 0 }),
//   };
//
//   await notifier.send(user, InvoicePaid);   // → { mail: {ok}, database: {ok, id} }
//
// Channels are pluggable and their transports injectable, so the whole thing is
// unit-testable with no network and no real provider.

import { sdkWireHeaders } from "./sdk";

// ---------------------------------------------------------------------------
// Messages & results
// ---------------------------------------------------------------------------

export interface MailMessage {
  subject: string;
  html?: string;
  text?: string;
  /** Overrides the recipient's `email`. */
  to?: string[];
}
export interface SmsMessage {
  text: string;
  /** Overrides the recipient's `phone`. */
  to?: string;
}
export interface SlackMessage {
  text: string;
  blocks?: unknown[];
  /** Overrides the channel's default webhook. */
  webhookUrl?: string;
}
export interface WebhookMessage {
  payload: unknown;
  /** Overrides the channel's default url. */
  url?: string;
}

export interface ChannelResult {
  channel: string;
  ok: boolean;
  /** Provider/message id when the transport returns one. */
  id?: string;
  error?: string;
  /** True when the notification didn't implement this channel's builder. */
  skipped?: boolean;
}

const skip = (channel: string): ChannelResult => ({ channel, ok: true, skipped: true });

// ---------------------------------------------------------------------------
// Notification & channel contracts
// ---------------------------------------------------------------------------

export interface Notification<R = any> {
  /** Which channels to deliver on for this recipient. */
  via(recipient: R): string[];
  toMail?(recipient: R): MailMessage;
  toSms?(recipient: R): SmsMessage;
  toSlack?(recipient: R): SlackMessage;
  /** A row to persist for an in-app feed. */
  toDatabase?(recipient: R): Record<string, unknown>;
  toWebhook?(recipient: R): WebhookMessage;
}

export interface Channel {
  readonly name: string;
  send(recipient: any, notification: Notification): Promise<ChannelResult>;
}

export interface Notifier {
  /** Fan a notification out to every channel its `via()` lists. Never rejects —
   *  each channel's outcome (incl. errors) is a `ChannelResult`. */
  send<R>(recipient: R, notification: Notification<R>): Promise<Record<string, ChannelResult>>;
  channel(name: string): Channel | undefined;
  readonly channels: string[];
}

export function createNotifier(channels: Channel[]): Notifier {
  const map = new Map(channels.map((c) => [c.name, c]));
  return {
    channel: (name) => map.get(name),
    get channels() {
      return [...map.keys()];
    },
    async send(recipient, notification) {
      const wanted = notification.via(recipient) ?? [];
      const results: Record<string, ChannelResult> = {};
      await Promise.all(
        wanted.map(async (name) => {
          const ch = map.get(name);
          if (!ch) {
            results[name] = { channel: name, ok: false, error: "no such channel registered" };
            return;
          }
          try {
            results[name] = await ch.send(recipient, notification);
          } catch (e) {
            results[name] = { channel: name, ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in channels
// ---------------------------------------------------------------------------

/** Email via bext's loopback SDK endpoint (X-Bext-App-Id bypass), or an
 *  injected `deliver` (for tests / a custom transport). */
export function mailChannel(opts: {
  appId: string;
  deliver?: (msg: MailMessage & { to: string[] }) => Promise<ChannelResult>;
}): Channel {
  const deliver =
    opts.deliver ??
    (async (msg: MailMessage & { to: string[] }): Promise<ChannelResult> => {
      const r = await fetch("http://127.0.0.1/__bext/sdk/email/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Bext-App-Id": opts.appId,
          ...sdkWireHeaders(opts.appId),
        },
        body: JSON.stringify({ to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
      });
      return { channel: "mail", ok: r.ok, error: r.ok ? undefined : `HTTP ${r.status}` };
    });
  return {
    name: "mail",
    async send(recipient, notification) {
      if (!notification.toMail) return skip("mail");
      const msg = notification.toMail(recipient);
      const to = msg.to ?? (recipient?.email ? [recipient.email] : []);
      if (!to.length) return { channel: "mail", ok: false, error: "no recipient email" };
      return deliver({ ...msg, to });
    },
  };
}

/** SMS. bext ships no SMS provider, so you MUST inject a `send` transport
 *  (Twilio, Vonage, …). This is the abstraction; the provider is yours. */
export function smsChannel(opts: {
  send: (msg: { to: string; text: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
}): Channel {
  return {
    name: "sms",
    async send(recipient, notification) {
      if (!notification.toSms) return skip("sms");
      const msg = notification.toSms(recipient);
      const to = msg.to ?? recipient?.phone;
      if (!to) return { channel: "sms", ok: false, error: "no recipient phone" };
      const r = await opts.send({ to, text: msg.text });
      return { channel: "sms", ok: r.ok, id: r.id, error: r.error };
    },
  };
}

/** Slack via an incoming-webhook URL, or an injected `deliver`. */
export function slackChannel(opts: {
  webhookUrl?: string;
  deliver?: (url: string, body: { text: string; blocks?: unknown[] }) => Promise<ChannelResult>;
}): Channel {
  const deliver =
    opts.deliver ??
    (async (url: string, body: { text: string; blocks?: unknown[] }): Promise<ChannelResult> => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { channel: "slack", ok: r.ok, error: r.ok ? undefined : `HTTP ${r.status}` };
    });
  return {
    name: "slack",
    async send(recipient, notification) {
      if (!notification.toSlack) return skip("slack");
      const msg = notification.toSlack(recipient);
      const url = msg.webhookUrl ?? opts.webhookUrl;
      if (!url) return { channel: "slack", ok: false, error: "no webhook url" };
      return deliver(url, { text: msg.text, blocks: msg.blocks });
    },
  };
}

/** In-app feed: persist a row through an ORM model (or anything with
 *  `create(data)`). Composes with @bext-stack/framework/orm. */
export function databaseChannel(opts: { model: { create(data: Record<string, unknown>): any } }): Channel {
  return {
    name: "database",
    async send(recipient, notification) {
      if (!notification.toDatabase) return skip("database");
      const row = opts.model.create(notification.toDatabase(recipient));
      return { channel: "database", ok: true, id: row?.id != null ? String(row.id) : undefined };
    },
  };
}

/** POST a JSON payload to a webhook, or an injected `deliver`. */
export function webhookChannel(opts: {
  url?: string;
  deliver?: (url: string, payload: unknown) => Promise<ChannelResult>;
}): Channel {
  const deliver =
    opts.deliver ??
    (async (url: string, payload: unknown): Promise<ChannelResult> => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { channel: "webhook", ok: r.ok, error: r.ok ? undefined : `HTTP ${r.status}` };
    });
  return {
    name: "webhook",
    async send(recipient, notification) {
      if (!notification.toWebhook) return skip("webhook");
      const msg = notification.toWebhook(recipient);
      const url = msg.url ?? opts.url;
      if (!url) return { channel: "webhook", ok: false, error: "no webhook url" };
      return deliver(url, msg.payload);
    },
  };
}

/** Build a custom channel from a single async function. */
export function defineChannel(
  name: string,
  send: (recipient: any, notification: Notification) => Promise<ChannelResult>,
): Channel {
  return { name, send };
}
