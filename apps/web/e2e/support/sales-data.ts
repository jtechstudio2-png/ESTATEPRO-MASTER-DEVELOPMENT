import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

import type { E2eState } from './state';

/**
 * Sales-pipeline data for the Phase 6 specs (S5), created through the API
 * when those specs start, after the earlier specs have run, so the shared
 * seed and the exact counts the earlier specs check stay as they were.
 *
 * A live sale listing on a new villa that Ama owns, a buyer, a deal with an
 * open offer, and viewings conducted by the agent: one over without an
 * outcome, one tomorrow. Only the listing's go-live and the past viewing's
 * time are written directly, as the API tests do (publishing and booking in
 * the past are refused by the API).
 */
export interface SalesData {
  saleListing: { id: string; reference: string };
  buyer: { id: string };
  deal: { id: string; reference: string };
  offer: { id: string };
  pastViewing: { id: string };
  upcomingViewing: { id: string };
}

const CLIENT_ID = 'estatepro-web-e2e';
const REDIRECT_URI = 'http://127.0.0.1/e2e-callback';

/** An access token from the test identity provider, through its ordinary authorisation-code flow (PKCE). */
async function accessToken(idpUrl: string, email: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const form = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: 's', nonce: 'n', code_challenge: challenge, email, mfa: '1' });
  const authorised = await fetch(`${idpUrl}/authorize`, { method: 'POST', body: form, redirect: 'manual' });
  const code = new URL(authorised.headers.get('location') ?? '').searchParams.get('code');
  if (!code) throw new Error(`No authorisation code for ${email}`);
  const token = await fetch(`${idpUrl}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI }),
  });
  const body = (await token.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`No access token for ${email}`);
  return body.access_token;
}

export async function createSalesData(state: E2eState): Promise<SalesData> {
  const token = await accessToken(state.idpUrl, state.users.owner.email);
  const companyId = state.companies.accra.id;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${state.apiUrl}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': companyId,
        'content-type': 'application/json',
        ...(method === 'POST' && !path.includes('/') ? { 'idempotency-key': crypto.randomUUID() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  const db = new pg.Client({ connectionString: state.adminDatabaseUrl });
  await db.connect();
  try {
    const agent = await db.query<{ id: string }>(
      `SELECT m.id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND u.email = $2`,
      [companyId, state.users.agent.email],
    );
    const agentMembership = agent.rows[0]!.id;
    const types = await call<{ data: Array<{ id: string; code: string }> }>('GET', 'property-types?limit=200');
    const villa = await call<{ id: string }>('POST', 'properties', {
      name: 'Airport Hills Villa',
      propertyTypeId: types.data.find((type) => type.code === 'villa')!.id,
      officeId: state.companies.accra.officeId,
      createWholePropertyUnit: true,
      address: { countryCode: 'GH', addressLine1: '9 Volta Street', dependentLocality: 'Airport Residential', locality: 'Accra', adminArea1: 'Greater Accra' },
    });
    const unit = await db.query<{ id: string }>('SELECT id FROM units WHERE property_id = $1 LIMIT 1', [villa.id]);
    const from = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
    await call('POST', `properties/${villa.id}/ownerships`, { ownerContactId: state.records.crm.ama.id, effectiveFrom: from });
    const saleListing = await call<{ id: string; reference: string }>('POST', 'listings', {
      unitId: unit.rows[0]!.id,
      listingType: 'sale',
      price: { amount: '1200000.00', currency: 'GHS' },
      title: '4-bed villa, Airport Hills',
      description: 'Detached villa with a garden, two streets from the main road.',
      agentMembershipId: agentMembership,
    });
    await db.query(`UPDATE listings SET status = 'available', listed_at = now() WHERE id = $1`, [saleListing.id]);
    const buyer = await call<{ id: string }>('POST', 'contacts', {
      contactType: 'person',
      displayName: 'Kofi Mensah',
      primaryPhone: '+233 24 555 7310',
      officeId: state.companies.accra.officeId,
      ownerMembershipId: agentMembership,
      relationships: ['buyer'],
    });
    const deal = await call<{ id: string; reference: string }>('POST', 'deals', {
      dealType: 'sale',
      primaryContactId: buyer.id,
      listingId: saleListing.id,
      ownerMembershipId: agentMembership,
      expectedValue: { amount: '1200000.00', currency: 'GHS' },
    });
    const offer = await call<{ id: string }>('POST', 'offers', {
      dealId: deal.id,
      offeredByContactId: buyer.id,
      direction: 'from_buyer',
      amount: { amount: '1100000.00', currency: 'GHS' },
      conditions: 'Subject to a survey',
    });
    const tomorrow = (hour: number) => {
      const at = new Date(Date.now() + 86_400_000);
      at.setUTCHours(hour, 0, 0, 0);
      return at.toISOString();
    };
    const book = (start: string, end: string) =>
      call<{ id: string }>('POST', 'viewings', {
        listingId: saleListing.id,
        agentMembershipId: agentMembership,
        viewingType: 'in_person',
        scheduledStart: start,
        scheduledEnd: end,
        attendeeContactIds: [buyer.id],
        dealId: deal.id,
        confirmed: false,
      });
    const pastViewing = await book(tomorrow(9), tomorrow(10));
    await db.query(`UPDATE viewings SET scheduled_start = now() - interval '26 hours', scheduled_end = now() - interval '25 hours' WHERE id = $1`, [pastViewing.id]);
    const upcomingViewing = await book(tomorrow(11), tomorrow(12));
    return { saleListing, buyer, deal, offer, pastViewing, upcomingViewing };
  } finally {
    await db.end();
  }
}
