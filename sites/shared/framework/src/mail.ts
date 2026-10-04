// mail.ts — transactional email templating for PRISM apps (Laravel Mailables).
//
// `renderMailable(spec)` turns a structured spec (greeting, paragraphs, a call-to-
// action button, salutation) into a responsive, inline-styled HTML email PLUS a
// plaintext alternative — the Laravel Markdown-mail experience, no build step.
// The result is exactly the `{ subject, html, text }` shape the notifications
// module's mail channel wants, so the two compose:
//
//   import { renderMailable } from "@bext-stack/framework/mail";
//   const msg = renderMailable({
//     subject: "Your receipt",
//     greeting: "Hi Ada,",
//     intro: ["Thanks for your order — here's your receipt."],
//     action: { text: "View receipt", url: "https://app/receipt/42" },
//     outro: ["If you didn't make this purchase, contact support."],
//     salutation: "— The Shop",
//   });
//   // msg: { subject, html, text }  → notification.toMail() / sdk.email.send()

export interface MailAction {
  text: string;
  url: string;
}

export interface MailBrand {
  name?: string;
  /** Accent colour for the header + button. Default `#4f46e5`. */
  color?: string;
  footer?: string;
}

export interface MailableSpec {
  subject: string;
  greeting?: string;
  /** Paragraphs before the action button. */
  intro?: string[];
  /** A single call-to-action button. */
  action?: MailAction;
  /** Paragraphs after the button. */
  outro?: string[];
  salutation?: string;
  brand?: MailBrand;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a mailable spec to `{ subject, html, text }`. User content is
 *  HTML-escaped in the HTML output; the URL is validated to http(s). */
export function renderMailable(spec: MailableSpec): RenderedMail {
  const brand = spec.brand ?? {};
  const color = brand.color && /^#[0-9a-fA-F]{3,8}$/.test(brand.color) ? brand.color : "#4f46e5";
  const intro = spec.intro ?? [];
  const outro = spec.outro ?? [];
  const safeUrl = spec.action && /^https?:\/\//i.test(spec.action.url) ? spec.action.url : undefined;

  const p = (t: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${esc(t)}</p>`;

  const button = spec.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td align="center" bgcolor="${color}" style="border-radius:6px;">` +
      `<a href="${esc(safeUrl ?? "#")}" target="_blank" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(spec.action.text)}</a>` +
      `</td></tr></table>`
    : "";

  const html =
    `<!-- ${esc(spec.subject)} -->` +
    `<div style="margin:0;padding:24px 0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">` +
    (brand.name
      ? `<tr><td style="padding:20px 32px;border-bottom:3px solid ${color};font-size:18px;font-weight:700;color:#111827;">${esc(brand.name)}</td></tr>`
      : "") +
    `<tr><td style="padding:32px;">` +
    (spec.greeting ? p(spec.greeting) : "") +
    intro.map(p).join("") +
    button +
    outro.map(p).join("") +
    (spec.salutation ? p(spec.salutation) : "") +
    `</td></tr>` +
    `<tr><td style="padding:16px 32px;background:#fafafa;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">${esc(brand.footer ?? `© ${brand.name ?? "Sent by bext"}`)}</td></tr>` +
    `</table></td></tr></table></div>`;

  const textParts: string[] = [];
  if (spec.greeting) textParts.push(spec.greeting);
  textParts.push(...intro);
  if (spec.action) textParts.push(`${spec.action.text}: ${safeUrl ?? spec.action.url}`);
  textParts.push(...outro);
  if (spec.salutation) textParts.push(spec.salutation);
  if (brand.footer) textParts.push("", brand.footer);
  const text = textParts.join("\n\n");

  return { subject: spec.subject, html, text };
}
