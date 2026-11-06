import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_FILE = join(import.meta.dirname, '..', '.state.json');

export interface SeedUser {
  email: string;
  name: string;
}

export interface E2eState {
  webUrl: string;
  apiUrl: string;
  idpUrl: string;
  adminDatabaseUrl: string;
  users: Record<'owner' | 'agent' | 'manager' | 'tech' | 'arabic', SeedUser>;
  companies: Record<'accra' | 'doha' | 'london', { id: string; name: string; officeId: string }>;
  records: {
    osuCourt: { id: string; reference: string; unitIds: string[] };
    laboneVilla: { id: string; reference: string };
    eastLegon: { id: string; reference: string };
    dohaTower: { id: string; reference: string };
    listing: { id: string; reference: string };
    keySet: { id: string };
    crm: {
      ama: { id: string; reference: string };
      amaDuplicate: { id: string; reference: string };
      seller: { id: string; reference: string };
      erased: { id: string; reference: string };
      portalLead: { id: string; reference: string };
      agentLead: { id: string; reference: string };
      agentTask: { id: string };
      dohaContact: { id: string; reference: string };
      dohaErased: { id: string; reference: string };
    };
    privacy: {
      requester: { id: string; reference: string };
      overdueRequest: { id: string; reference: string };
      toErase: { id: string; reference: string };
      dohaRequest: { id: string; reference: string };
    };
  };
}

let cached: E2eState | null = null;

export function e2eState(): E2eState {
  cached ??= JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;
  return cached;
}
