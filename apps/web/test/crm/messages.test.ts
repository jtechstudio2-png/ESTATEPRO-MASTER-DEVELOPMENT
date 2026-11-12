import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTACT_ROLES, LEAD_STATUSES, LEAD_TYPES } from '@/components/crm/labels';
import { CONTACT_VIEWS } from '@/components/contacts/contact-list';
import { LOGGABLE_TYPES } from '@/components/activity/activity-labels';

/**
 * Keys built at run time (`t(\`role.${role}\`)`) are not seen by the static
 * message check: every value the code can produce must exist in both languages.
 */
const root = join(import.meta.dirname, '..', '..', 'src', 'messages');
function load(language: string, namespace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, language, `${namespace}.json`), 'utf8')) as Record<string, unknown>;
}
function has(messages: Record<string, unknown>, path: string): boolean {
  let node: unknown = messages;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

const families: Array<[string, string, readonly string[]]> = [
  ['crm', 'role', CONTACT_ROLES],
  ['crm', 'leadStatus', LEAD_STATUSES],
  ['crm', 'leadType', LEAD_TYPES],
  ['crm', 'identityStatus', ['none', 'pending', 'in_review', 'verified', 'failed', 'expired']],
  ['crm', 'consentChannel', ['any', 'email', 'sms', 'whatsapp', 'phone', 'post']],
  ['crm', 'priority', ['low', 'normal', 'high', 'urgent']],
  ['contacts', 'views', CONTACT_VIEWS],
  ['contacts', 'viewTitles', CONTACT_VIEWS.filter((view) => view !== 'all')],
  ['contacts', 'methodType', ['mobile', 'phone', 'whatsapp', 'email', 'fax', 'website', 'other']],
  ['contacts', 'channel', ['whatsapp', 'sms', 'email', 'phone', 'post']],
  ['contacts', 'matchedOn', ['email', 'phone', 'tax_number', 'identity_document']],
  ['activity', 'type', ['call', 'email', 'sms', 'whatsapp', 'meeting', 'note', 'viewing', 'offer', 'status_change', 'document', 'portal', 'system', ...LOGGABLE_TYPES]],
  ['leads', 'tab', ['inbox', 'mine', 'unassigned', 'open', 'closed']],
  ['leads', 'empty', ['inbox', 'mine', 'unassigned', 'open', 'closed']],
  ['followUps', 'range', ['open', 'overdue', 'today', 'week', 'done', 'cancelled']],
  ['followUps', 'empty', ['open', 'overdue', 'today', 'week', 'done', 'cancelled']],
  ['identity', 'checkType', ['identity', 'address', 'source_of_funds', 'sanctions_pep', 'company_ownership']],
  ['consent', 'purposeValue', ['marketing', 'property_alerts', 'data_processing', 'third_party_sharing', 'portal_terms']],
  ['consent', 'viaValue', ['web_form', 'portal', 'verbal', 'paper', 'import', 'email', 'merge']],
  ['requirements', 'financing', ['cash', 'mortgage_approved', 'mortgage_in_progress', 'not_started', 'not_applicable']],
  ['requirements', 'per', ['weekly', 'monthly', 'quarterly', 'semi_annual', 'annual']],
  ['exports', 'statusValue', ['completed', 'failed', 'expired']],
  ['identity', 'queue', ['open', 'expiring', 'verified', 'failed', 'expired']],
  ['identity', 'queueEmpty', ['open', 'expiring', 'verified', 'failed', 'expired']],
  ['landlord', 'notVisibleCode', ['other_owners', 'tenant_buyer_contacts', 'staff_records', 'protected_details']],
  ['merge', 'blocker', ['same_contact', 'already_merged', 'anonymised', 'keep_archived', 'different_types', 'financial_records', 'both_portal', 'erasure_request']],
  ['adminDashboard', 'attention', ['unassigned_leads', 'response_overdue', 'expired_invitations', 'identity_checks_expiring', 'failed_imports', 'agent_licences', 'privacy_requests_overdue']],
  ['privacy', 'status', ['received', 'verifying', 'in_progress', 'completed', 'refused', 'withdrawn']],
  ['privacy', 'type', ['access', 'erasure']],
  ['privacy', 'typeLong', ['access', 'erasure']],
  ['privacy', 'view', ['open', 'overdue', 'closed', 'all']],
  ['privacy', 'empty', ['open', 'overdue', 'closed', 'all']],
  ['privacy', 'channel', ['email', 'phone', 'in_person', 'post', 'web_form', 'other']],
  ['privacy', 'identityMethod', ['documents_seen', 'known_contact_details', 'email_confirmation', 'other']],
  ['privacy', 'evidenceKind', ['request', 'identity', 'correspondence', 'response', 'other']],
  ['privacy', 'event', ['created', 'status_changed', 'assigned', 'identity_verified', 'due_extended', 'evidence_added', 'access_report_generated', 'erasure_carried_out', 'erasure_blocked']],
  ['exports', 'type', ['contacts', 'leads', 'subject_access']],
];

describe('dynamic message keys', () => {
  for (const language of ['en', 'ar']) {
    it(`has every run-time key in ${language}`, () => {
      const missing: string[] = [];
      for (const [namespace, prefix, values] of families) {
        const messages = load(language, namespace);
        for (const value of values) if (!has(messages, `${prefix}.${value}`)) missing.push(`${namespace}.${prefix}.${value}`);
      }
      expect(missing).toEqual([]);
    });
  }
});
