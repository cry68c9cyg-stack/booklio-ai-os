/** Sends the morning briefing. Without a configured channel the briefing is only stored. */

export type DeliveryEnv = {
  TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM?: string;
  BULKGATE_APP_ID?: string; BULKGATE_TOKEN?: string; SMS_SENDER?: string; WHATSAPP_SENDER?: string; WHATSAPP_TEMPLATE?: string;
};
export type DeliveryStatus = 'stored' | 'delivered' | 'failed';

const TWILIO_API = 'https://api.twilio.com';
const BULKGATE_API = 'https://portal.bulkgate.com/api/2.0/advanced/transactional';

const bulkgateConfigured = (env: DeliveryEnv) => !!(env.BULKGATE_APP_ID && env.BULKGATE_TOKEN);
const twilioConfigured = (env: DeliveryEnv) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);

export function deliveryConfigured(env: DeliveryEnv): boolean {
  return bulkgateConfigured(env) || twilioConfigured(env);
}

/** BulkGate (WhatsApp with SMS fallback, preferred) or Twilio SMS, one message per recipient. Any failed recipient marks the whole delivery failed so the next hour retries it. */
export async function deliver(env: DeliveryEnv, recipients: string[], text: string): Promise<DeliveryStatus> {
  if (!deliveryConfigured(env) || !recipients.length) return 'stored';
  if (bulkgateConfigured(env)) return deliverBulkGate(env, recipients, text);
  const url = `${TWILIO_API}/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID!)}/Messages.json`;
  const authorization = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  let failed = false;
  for (const to of recipients) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {authorization, 'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({To: to, From: env.TWILIO_FROM!, Body: text}),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) failed = true;
      await response.body?.cancel();
    } catch {
      failed = true;
    }
  }
  return failed ? 'failed' : 'delivered';
}

/** 7-bit SMS text: Czech diacritics and symbols folded to ASCII, cut to BulkGate's 612-character limit. */
export function smsText(text: string): string {
  const ascii = text.replace(/⚠\s?/g, '! ').replace(/·/g, '|').replace(/−/g, '-').replace(/…/g, '...')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e\n]/g, '');
  return ascii.length > 612 ? ascii.slice(0, 609) + '...' : ascii;
}

/** WhatsApp template parameters must not contain line breaks, so lines are joined with ' | '. */
export function whatsappText(text: string): string {
  const line = text.split('\n').map(part => part.trim()).filter(Boolean).join(' | ');
  return line.length > 1024 ? line.slice(0, 1021) + '...' : line;
}

/**
 * BulkGate Advanced API 2.0. With WHATSAPP_SENDER set the briefing goes to WhatsApp as an approved template
 * (one text parameter) and falls back to SMS when WhatsApp does not deliver; without it, SMS only.
 * A number as SMS sender becomes gOwn, anything else a text sender (gText).
 */
async function deliverBulkGate(env: DeliveryEnv, recipients: string[], text: string): Promise<DeliveryStatus> {
  const sender = (env.SMS_SENDER || 'JamesDean').trim();
  const senderNumber = sender.replace(/[\s+]/g, '');
  const sms = /^\d{9,15}$/.test(senderNumber)
    ? {sender_id: 'gOwn', sender_id_value: senderNumber, unicode: false}
    : {sender_id: 'gText', sender_id_value: sender, unicode: false};
  const whatsappSender = env.WHATSAPP_SENDER?.replace(/[\s+]/g, '');
  const channel = whatsappSender
    ? {whatsapp: {sender: whatsappSender, expiration: 600, template: {
        template: env.WHATSAPP_TEMPLATE || 'ranni_prehled', language: 'cs', body: [{type: 'text', text: whatsappText(text)}],
      }}, sms}
    : {sms};
  try {
    const response = await fetch(BULKGATE_API, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        application_id: env.BULKGATE_APP_ID, application_token: env.BULKGATE_TOKEN,
        number: recipients.map(to => to.replace(/^\+/, '')), text: smsText(text), channel,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => null) as {data?: {response?: {status?: string}[]}} | null;
    const rows = result?.data?.response ?? [];
    const ok = response.ok && rows.length === recipients.length && rows.every(row => ['accepted', 'scheduled', 'sent'].includes(row.status ?? ''));
    return ok ? 'delivered' : 'failed';
  } catch {
    return 'failed';
  }
}
