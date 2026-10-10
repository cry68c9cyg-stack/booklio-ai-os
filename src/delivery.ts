/** Sends the morning briefing. Without a configured channel the briefing is only stored. */

export type DeliveryEnv = {
  TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM?: string;
  BULKGATE_APP_ID?: string; BULKGATE_TOKEN?: string; SMS_SENDER?: string;
};
export type DeliveryStatus = 'stored' | 'delivered' | 'failed';

const TWILIO_API = 'https://api.twilio.com';
const BULKGATE_API = 'https://portal.bulkgate.com/api/1.0/simple/transactional';

const bulkgateConfigured = (env: DeliveryEnv) => !!(env.BULKGATE_APP_ID && env.BULKGATE_TOKEN);
const twilioConfigured = (env: DeliveryEnv) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);

export function deliveryConfigured(env: DeliveryEnv): boolean {
  return bulkgateConfigured(env) || twilioConfigured(env);
}

/** SMS through BulkGate (preferred) or Twilio, one message per recipient. Any failed recipient marks the whole delivery failed so the next hour retries it. */
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

/** BulkGate Simple API: a number as sender becomes gOwn, anything else a text sender (gText). Unicode keeps Czech diacritics. */
async function deliverBulkGate(env: DeliveryEnv, recipients: string[], text: string): Promise<DeliveryStatus> {
  const sender = (env.SMS_SENDER || 'JamesDean').trim();
  const senderNumber = sender.replace(/[\s+]/g, '');
  const senderFields = /^\d{9,15}$/.test(senderNumber)
    ? {sender_id: 'gOwn', sender_id_value: senderNumber}
    : {sender_id: 'gText', sender_id_value: sender};
  let failed = false;
  for (const to of recipients) {
    try {
      const response = await fetch(BULKGATE_API, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          application_id: env.BULKGATE_APP_ID, application_token: env.BULKGATE_TOKEN,
          number: to.replace(/^\+/, ''), text, unicode: true, ...senderFields,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => null) as {data?: {status?: string}} | null;
      if (!response.ok || !['accepted', 'scheduled'].includes(result?.data?.status ?? '')) failed = true;
    } catch {
      failed = true;
    }
  }
  return failed ? 'failed' : 'delivered';
}
