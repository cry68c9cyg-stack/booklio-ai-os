/** Sends the morning briefing. Without a configured channel the briefing is only stored. */

export type DeliveryEnv = {TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM?: string};
export type DeliveryStatus = 'stored' | 'delivered' | 'failed';

const TWILIO_API = 'https://api.twilio.com';

export function deliveryConfigured(env: DeliveryEnv): boolean {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

/** SMS through Twilio, one message per recipient. Any failed recipient marks the whole delivery failed so the next hour retries it. */
export async function deliver(env: DeliveryEnv, recipients: string[], text: string): Promise<DeliveryStatus> {
  if (!deliveryConfigured(env) || !recipients.length) return 'stored';
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
