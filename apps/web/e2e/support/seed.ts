import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import pg from 'pg';

import type { E2eIdp } from './idp';
import type { E2eState } from './state';

interface SeedOptions {
  apiUrl: string;
  idp: E2eIdp;
  platformDatabaseUrl: string;
  adminDatabaseUrl: string;
}

type Seeded = Pick<E2eState, 'users' | 'companies' | 'records'>;

const apiDir = join(import.meta.dirname, '..', '..', '..', 'api');

/** A tiny API client acting as one user in one company. */
class Api {
  constructor(
    private readonly options: SeedOptions,
    private readonly email: string,
    private readonly companyId: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown, version?: number): Promise<T> {
    const token = await this.options.idp.accessToken(this.email);
    const response = await fetch(`${this.options.apiUrl}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': this.companyId,
        'content-type': 'application/json',
        ...(method === 'POST' && !path.includes('/') ? { 'idempotency-key': crypto.randomUUID() } : {}),
        ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }
}

/**
 * Seed data for the end-to-end tests: three companies (Ghana in English,
 * Qatar in Arabic, a read-only UK company), staff in several roles, and
 * properties, units, listings, notes and keys created through the API so
 * every business rule applies.
 */
export async function seed(options: SeedOptions): Promise<Seeded> {
  const db = new pg.Client({ connectionString: options.adminDatabaseUrl });
  await db.connect();
  try {
    const staff = 'platform-admin@estatepro.test';
    await db.query(`INSERT INTO users (email, display_name, status) VALUES ($1, 'Platform Admin', 'active')`, [staff]);
    await db.query(`INSERT INTO platform_staff (user_id, role) SELECT id, 'super_admin' FROM users WHERE email = $1`, [staff]);

    const provision = (args: string[]) =>
      JSON.parse(
        execFileSync('node', ['dist/cli/provision-company.js', '--staff-email', staff, '--data-region', 'eu-west', '--status', 'active', ...args], {
          cwd: apiDir,
          env: { ...process.env, PLATFORM_DATABASE_URL: options.platformDatabaseUrl },
        }).toString(),
      ) as { companyId: string; officeId: string; ownerMembershipId: string };

    const users = {
      owner: { email: 'kofi.owner@accra.test', name: 'Kofi Owusu' },
      agent: { email: 'ama.agent@accra.test', name: 'Ama Boateng' },
      manager: { email: 'yaw.manager@accra.test', name: 'Yaw Asante' },
      tech: { email: 'kwame.tech@accra.test', name: 'Kwame Mensah' },
      arabic: { email: 'mariam@doha.test', name: 'مريم الكعبي' },
    };
    const accra = provision([
      '--legal-name', 'Accra Homes Ltd', '--slug', 'accra-homes', '--country', 'GH',
      '--office-code', 'HQ', '--office-name', 'Osu office', '--owner-email', users.owner.email, '--owner-name', users.owner.name,
    ]);
    const doha = provision([
      '--legal-name', 'Doha Lettings W.L.L.', '--slug', 'doha-lettings', '--country', 'QA',
      '--office-code', 'HQ', '--office-name', 'مكتب الدفنة', '--owner-email', users.arabic.email, '--owner-name', users.arabic.name,
    ]);
    const london = provision([
      '--legal-name', 'London Lets Ltd', '--slug', 'london-lets', '--country', 'GB', '--jurisdiction', 'GB-ENG',
      '--office-code', 'HQ', '--office-name', 'Camden office', '--owner-email', 'owner@london.test', '--owner-name', 'Harriet Clarke',
    ]);

    const member = async (companyId: string, officeId: string, email: string, name: string, roleKey: string) => {
      await db.query(`INSERT INTO users (email, display_name, status) VALUES ($1, $2, 'active') ON CONFLICT (email) DO NOTHING`, [email, name]);
      const result = await db.query<{ id: string }>(
        `INSERT INTO company_memberships (company_id, user_id, role_id, membership_type, status)
         SELECT $1, u.id, r.id, 'staff', 'active' FROM users u, roles r
         WHERE u.email = $2 AND r.key = $3 AND r.company_id IS NULL RETURNING id`,
        [companyId, email, roleKey],
      );
      await db.query(`INSERT INTO membership_offices (company_id, membership_id, office_id) VALUES ($1, $2, $3)`, [companyId, result.rows[0]!.id, officeId]);
      return result.rows[0]!.id;
    };
    const agentMembership = await member(accra.companyId, accra.officeId, users.agent.email, users.agent.name, 'agent');
    const managerMembership = await member(accra.companyId, accra.officeId, users.manager.email, users.manager.name, 'property_manager');
    await member(accra.companyId, accra.officeId, users.tech.email, users.tech.name, 'maintenance_staff');
    // The Accra owner also works for Doha (company picker and switching) and London (read-only banner).
    await member(doha.companyId, doha.officeId, users.owner.email, users.owner.name, 'office_admin');
    await member(london.companyId, london.officeId, users.owner.email, users.owner.name, 'agent');
    await db.query(`UPDATE companies SET status = 'read_only' WHERE id = $1`, [london.companyId]);

    const accraApi = new Api(options, users.owner.email, accra.companyId);
    const types = await accraApi.call<{ data: Array<{ id: string; code: string }> }>('GET', 'property-types?limit=200');
    const typeId = (code: string) => types.data.find((type) => type.code === code)!.id;

    const property = (body: Record<string, unknown>) =>
      accraApi.call<{ id: string; reference: string }>('POST', 'properties', { officeId: accra.officeId, createWholePropertyUnit: false, ...body });
    const ghAddress = (line: string, area: string, location?: [number, number]) => ({
      countryCode: 'GH',
      addressLine1: line,
      dependentLocality: area,
      locality: 'Accra',
      adminArea1: 'Greater Accra',
      ...(location ? { latitude: location[0], longitude: location[1], geocodeSource: 'manual_pin', geocodeAccuracy: 'rooftop' } : {}),
    });

    const osuCourt = await property({
      name: 'Osu Court',
      propertyTypeId: typeId('apartment_building'),
      address: { ...ghAddress('12 Oxford Street', 'Osu', [5.5571, -0.1818]), localComponents: { digital_address: 'GA-123-4567' } },
      isManaged: true,
      yearBuilt: 2015,
      floorsCount: 4,
    });
    const unitIds: string[] = [];
    for (const [label, bedrooms] of [['Flat 1A', 2], ['Flat 1B', 2], ['Flat 1C', 3]] as const) {
      const unit = await accraApi.call<{ id: string }>('POST', `properties/${osuCourt.id}/units`, {
        unitLabel: label,
        isWholeProperty: false,
        unitTypeId: typeId('apartment'),
        bedrooms,
        bathrooms: 1,
        floorArea: { value: 85, unit: 'sqm' },
      });
      unitIds.push(unit.id);
    }
    await accraApi.call('POST', `units/${unitIds[2]}/availability`, { availability: 'under_maintenance', note: 'Bathroom refit', until: null }, 1);
    const laboneVilla = await property({
      name: 'Labone Villa',
      propertyTypeId: typeId('villa'),
      address: ghAddress('4 Sixth Street', 'Labone', [5.5642, -0.1712]),
      createWholePropertyUnit: true,
    });
    const eastLegon = await property({ name: 'East Legon Plot 4', propertyTypeId: typeId('residential_plot'), address: ghAddress('Lagos Avenue', 'East Legon') });
    for (let index = 1; index <= 52; index += 1) {
      await property({
        name: `Cantonments House ${index}`,
        propertyTypeId: typeId('house_detached'),
        address: ghAddress(`${index} Switchback Road`, 'Cantonments', [5.575 + index * 0.0005, -0.175 - index * 0.0004]),
      });
    }

    const listing = await accraApi.call<{ id: string; reference: string }>('POST', 'listings', {
      unitId: unitIds[0],
      listingType: 'rent',
      price: { amount: '6000.00', currency: 'GHS' },
      rentFrequency: 'monthly',
      title: '2-bed apartment, Osu',
      description: 'Bright two-bedroom flat close to Oxford Street.',
    });
    await accraApi.call('POST', `properties/${osuCourt.id}/notes`, {
      body: 'Gate sticks; lift and push.',
      category: 'access',
      visibility: 'internal',
      isPinned: true,
    });
    const keySet = await accraApi.call<{ id: string }>('POST', `properties/${osuCourt.id}/key-sets`, { label: 'Main entrance', status: 'in_office' });
    await accraApi.call('POST', `key-sets/${keySet.id}/check-out`, {
      holderMembershipId: managerMembership,
      dueBackAt: new Date(Date.now() + 3_600_000).toISOString(),
      note: 'Viewing with tenant',
    }, 1);
    // A second set for the key register specs, so they leave Osu Court's counts alone.
    const villaKeys = await accraApi.call<{ id: string }>('POST', `properties/${laboneVilla.id}/key-sets`, { label: 'Villa spare', status: 'in_office' });
    await accraApi.call('POST', `key-sets/${villaKeys.id}/check-out`, {
      holderMembershipId: managerMembership,
      dueBackAt: new Date(Date.now() + 3_600_000).toISOString(),
      note: 'Contractor visit',
    }, 1);
    // The due-back times have passed: both sets are overdue (D-1, D-2, K-2).
    await db.query(`UPDATE key_sets SET due_back_at = now() - interval '2 hours' WHERE id = ANY($1)`, [[keySet.id, villaKeys.id]]);

    const dohaApi = new Api(options, users.arabic.email, doha.companyId);
    const dohaTypes = await dohaApi.call<{ data: Array<{ id: string; code: string }> }>('GET', 'property-types?limit=200');
    const dohaTower = await dohaApi.call<{ id: string; reference: string }>('POST', 'properties', {
      name: 'برج الدفنة',
      propertyTypeId: dohaTypes.data.find((type) => type.code === 'apartment_building')!.id,
      officeId: doha.officeId,
      createWholePropertyUnit: false,
      address: {
        countryCode: 'QA',
        locality: 'الدفنة',
        localComponents: { zone_number: '61', street_number: '920', building_number: '12' },
        latitude: 25.3215,
        longitude: 51.5312,
        geocodeSource: 'manual_pin',
        geocodeAccuracy: 'rooftop',
      },
    });

    // CRM (Phase 5 milestone C5): contacts, consent, identity, requirements, leads and follow-ups,
    // created through the API so every business rule (encryption, duplicates, audit) applies.
    await accraApi.call('PUT', 'settings/crm', { leadResponseMinutes: 60 });
    const ama = await accraApi.call<{ id: string; reference: string }>('POST', 'contacts', {
      contactType: 'person',
      displayName: 'Ama Owusu',
      givenName: 'Ama',
      familyName: 'Owusu',
      primaryPhone: '+233 24 555 4412',
      primaryEmail: 'ama@example.test',
      preferredChannel: 'whatsapp',
      sourceCode: 'referral',
      officeId: accra.officeId,
      taxNumber: 'GHA-7788-4821',
      relationships: ['buyer', 'landlord'],
      consents: [{ purpose: 'marketing', channel: 'email', status: 'granted', lawfulBasis: 'consent', capturedVia: 'web_form' }],
    });
    await accraApi.call('POST', `contacts/${ama.id}/methods`, { methodType: 'whatsapp', value: '+233 24 555 4412' });
    await accraApi.call('POST', `contacts/${ama.id}/consents`, { purpose: 'marketing', channel: 'email', status: 'withdrawn', capturedVia: 'portal' });
    const amaDuplicate = await accraApi.call<{ id: string; reference: string }>('POST', 'contacts', {
      contactType: 'person',
      displayName: 'Ama Owusu-Boateng',
      primaryPhone: '+233 24 555 4499',
      primaryEmail: 'ama.ob@example.test',
      officeId: accra.officeId,
      relationships: ['tenant'],
    });
    const seller = await accraApi.call<{ id: string; reference: string }>('POST', 'contacts', {
      contactType: 'person',
      displayName: 'Esi Sarpong',
      primaryPhone: '+233 20 111 2233',
      officeId: accra.officeId,
      relationships: ['seller'],
    });
    const passport = await accraApi.call<{ id: string }>('POST', `contacts/${seller.id}/identity-documents`, {
      documentTypeCode: 'passport',
      issuingCountryCode: 'GH',
      documentNumber: 'G1234567',
      expiresOn: '2031-04-30',
    });
    await accraApi.call('POST', `contacts/${seller.id}/kyc-checks`, { checkType: 'identity', status: 'in_review', identityDocumentId: passport.id });
    await accraApi.call('POST', `contacts/${ama.id}/requirements`, {
      requirementType: 'buy',
      currencyCode: 'GHS',
      minPrice: '900000',
      maxPrice: '1200000',
      minBedrooms: 3,
      areas: [{ kind: 'locality', locality: 'East Legon' }],
      financingStatus: 'mortgage_approved',
    });
    // Ama owns Labone Villa (ownership records arrive with Phase 7 screens; the resolver reads them now).
    await db.query(
      `INSERT INTO property_ownerships (company_id, property_id, owner_contact_id, effective_from) VALUES ($1, $2, $3, current_date - 400)`,
      [accra.companyId, laboneVilla.id, ama.id],
    );
    const portalLead = await accraApi.call<{ id: string; reference: string }>('POST', 'leads', {
      contact: { contactType: 'person', displayName: 'Yaw Adjei', primaryPhone: '+233 20 777 7781', sourceCode: 'property_portal', relationships: ['applicant'] },
      leadType: 'rent',
      sourceCode: 'property_portal',
      listingId: listing.id,
      message: 'Is the flat still available? I can view this weekend.',
      assignedTo: null,
      officeId: accra.officeId,
    });
    const agentLead = await accraApi.call<{ id: string; reference: string }>('POST', 'leads', {
      contactId: ama.id,
      leadType: 'buy',
      sourceCode: 'referral',
      message: 'Looking for a 3-bed house in East Legon.',
      assignedTo: agentMembership,
      officeId: accra.officeId,
    });
    const agentTask = await accraApi.call<{ id: string }>('POST', 'tasks', {
      title: 'Call Ama about East Legon options',
      taskType: 'call',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      assignedTo: agentMembership,
      about: { entityType: 'lead', entityId: agentLead.id },
    });
    // Due an hour ago: overdue on My day, the follow-up list and the dashboards.
    await db.query(`UPDATE tasks SET due_at = now() - interval '1 hour' WHERE id = $1`, [agentTask.id]);
    const dohaContact = await dohaApi.call<{ id: string; reference: string }>('POST', 'contacts', {
      contactType: 'person',
      displayName: 'Ahmed Al-Kuwari',
      displayNameLocal: 'أحمد الكواري',
      primaryPhone: '+974 5512 0193',
      relationships: ['seller'],
    });

    return {
      users,
      companies: {
        accra: { id: accra.companyId, name: 'Accra Homes Ltd', officeId: accra.officeId },
        doha: { id: doha.companyId, name: 'Doha Lettings W.L.L.', officeId: doha.officeId },
        london: { id: london.companyId, name: 'London Lets Ltd', officeId: london.officeId },
      },
      records: {
        osuCourt: { ...osuCourt, unitIds },
        laboneVilla,
        eastLegon,
        dohaTower,
        listing,
        keySet,
        crm: { ama, amaDuplicate, seller, portalLead, agentLead, agentTask, dohaContact },
      },
    };
  } finally {
    await db.end();
  }
}
