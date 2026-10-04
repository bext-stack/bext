// billing.ts — Stripe subscriptions & billing for PRISM apps (a Cashier-lite).
//
// The app-developer facade over the Rust Payment Providers capability, and the
// reusable package bext sites kept re-implementing per-site. A thin, typed
// wrapper over the Stripe REST API (no `stripe` SDK — just fetch + form
// encoding) plus the security-critical bit everyone gets wrong: **webhook
// signature verification** (hex HMAC-SHA256 with a timestamp tolerance, reusing
// the pure-JS HMAC from @bext-stack/framework/auth).
//
//   const billing = createBilling({ secretKey: process.env.STRIPE_SECRET_KEY });
//
//   const { url } = await billing.checkoutSession({
//     priceId: "price_123", mode: "subscription",
//     successUrl: "https://app/ok", cancelUrl: "https://app/cancel", customer: "cus_1",
//   });
//   // redirect the user to `url`
//
//   const subs = await billing.listSubscriptions({ customer: "cus_1" });
//   if (subscribed(subs)) { /* unlock features */ }
//
//   // webhook route:
//   const event = constructEvent(rawBody, req.headers.get("stripe-signature"), whsec);
//   if (!event) return new Response("bad signature", { status: 400 });
//
// The HTTP transport is injectable (`request`), so the whole thing is unit-
// testable with a mock Stripe and no network.

import { hmacSha256Hex, timingSafeEqual } from "./auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Subscription {
  id: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "unpaid" | "incomplete" | string;
  customer?: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: unknown;
  [k: string]: unknown;
}

export interface Customer {
  id: string;
  email?: string;
  [k: string]: unknown;
}

export interface CheckoutSession {
  id: string;
  url: string;
  [k: string]: unknown;
}

/** The HTTP seam. `form` is a flat/bracketed param object; GET encodes it as a
 *  query string, POST as `application/x-www-form-urlencoded`. */
export type BillingRequest = (method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, unknown>) => Promise<any>;

export interface BillingConfig {
  secretKey?: string;
  /** Default `https://api.stripe.com`. */
  apiBase?: string;
  /** Inject a transport (tests / a mock). Overrides the default fetch. */
  request?: BillingRequest;
}

// ---------------------------------------------------------------------------
// Form encoding (Stripe uses form-encoded bodies with bracket nesting)
// ---------------------------------------------------------------------------

function flatten(obj: Record<string, unknown>, prefix = "", out: [string, string][] = []): [string, string][] {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const k = prefix ? `${prefix}[${key}]` : key;
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (v && typeof v === "object") flatten(v as Record<string, unknown>, `${k}[${i}]`, out);
        else out.push([`${k}[${i}]`, String(v)]);
      });
    } else if (typeof val === "object") {
      flatten(val as Record<string, unknown>, k, out);
    } else {
      out.push([k, String(val)]);
    }
  }
  return out;
}

/** Encode a (possibly nested) params object as Stripe-style form data. */
export function encodeForm(obj: Record<string, unknown>): string {
  return flatten(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function defaultTransport(secretKey: string, apiBase: string): BillingRequest {
  return async (method, path, form) => {
    let url = `${apiBase}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
    };
    if (form && method === "GET") url += `?${encodeForm(form)}`;
    else if (form) init.body = encodeForm(form);
    const r = await fetch(url, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message ?? `stripe ${r.status}`);
    return j;
  };
}

export interface Billing {
  createCustomer(params: { email?: string; name?: string; metadata?: Record<string, string> }): Promise<Customer>;
  checkoutSession(params: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    mode?: "subscription" | "payment";
    quantity?: number;
    customer?: string;
    customerEmail?: string;
    metadata?: Record<string, string>;
  }): Promise<CheckoutSession>;
  portalSession(params: { customer: string; returnUrl: string }): Promise<{ id: string; url: string }>;
  listSubscriptions(params: { customer: string; status?: string }): Promise<Subscription[]>;
  cancelSubscription(id: string, opts?: { atPeriodEnd?: boolean }): Promise<Subscription>;
  /** Escape hatch to any Stripe endpoint. */
  raw(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, unknown>): Promise<any>;
}

export function createBilling(config: BillingConfig): Billing {
  const req =
    config.request ??
    (() => {
      if (!config.secretKey) throw new Error("billing: provide `secretKey` or a `request` transport");
      return defaultTransport(config.secretKey, config.apiBase ?? "https://api.stripe.com");
    })();

  return {
    async createCustomer(params) {
      return (await req("POST", "/v1/customers", { email: params.email, name: params.name, metadata: params.metadata })) as Customer;
    },
    async checkoutSession(params) {
      const s = await req("POST", "/v1/checkout/sessions", {
        mode: params.mode ?? "subscription",
        line_items: [{ price: params.priceId, quantity: params.quantity ?? 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        customer: params.customer,
        customer_email: params.customer ? undefined : params.customerEmail,
        metadata: params.metadata,
      });
      return { id: s.id, url: s.url, ...s };
    },
    async portalSession(params) {
      const s = await req("POST", "/v1/billing_portal/sessions", { customer: params.customer, return_url: params.returnUrl });
      return { id: s.id, url: s.url };
    },
    async listSubscriptions(params) {
      const r = await req("GET", "/v1/subscriptions", { customer: params.customer, status: params.status });
      return (r?.data ?? []) as Subscription[];
    },
    async cancelSubscription(id, opts) {
      if (opts?.atPeriodEnd) {
        return (await req("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: true })) as Subscription;
      }
      return (await req("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`)) as Subscription;
    },
    raw(method, path, form) {
      return req(method, path, form);
    },
  };
}

const ACTIVE = new Set(["active", "trialing"]);

/** Is any subscription in an entitling state (active/trialing by default)? */
export function subscribed(subs: Subscription[], opts?: { statuses?: string[] }): boolean {
  const allowed = opts?.statuses ? new Set(opts.statuses) : ACTIVE;
  return subs.some((s) => allowed.has(s.status));
}

// ---------------------------------------------------------------------------
// Webhook signature verification (the security-critical bit)
// ---------------------------------------------------------------------------

/**
 * Verify a Stripe `Stripe-Signature` header against the raw request body.
 * Reconstructs `${timestamp}.${payload}`, HMACs it (hex) with the endpoint
 * secret, constant-time compares to the header's `v1`, and enforces a timestamp
 * tolerance (default 5 min) against replay.
 */
export function verifyStripeSignature(payload: string, header: string | null | undefined, secret: string, toleranceSecs = 300): boolean {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSecs) return false;
  const expected = hmacSha256Hex(secret, `${t}.${payload}`);
  return timingSafeEqual(expected, v1);
}

/** Verify then parse a Stripe webhook. Returns the event object, or null when
 *  the signature is invalid / expired. */
export function constructEvent(payload: string, header: string | null | undefined, secret: string, toleranceSecs = 300): any | null {
  if (!verifyStripeSignature(payload, header, secret, toleranceSecs)) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** Build a valid `Stripe-Signature` header for `payload` (for tests / mocking a
 *  webhook sender). */
export function signStripePayload(payload: string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${payload}`)}`;
}
