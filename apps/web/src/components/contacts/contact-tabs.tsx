'use client';

import { ActivityTimeline } from '@/components/activity/timeline';
import { useContact } from '@/components/crm/use-crm';
import { LeadList } from '@/components/leads/lead-list';
import { useSession } from '@/components/session';

/** A-1 on the contact record: one history across roles and leads. */
export function ContactActivityTab({ id }: { id: string }) {
  const { readOnly } = useSession();
  const contact = useContact(id);
  if (!contact.data) return null;
  const record = contact.data;
  const writable = !readOnly && record.access.canEdit && record.archivedAt === null && !record.isAnonymised && record.mergedIntoContactId === null;
  return <ActivityTimeline about={{ entityType: 'contact', entityId: id, label: record.displayName }} canLog={writable} />;
}

/** The contact's leads (C-2 Leads tab), open and closed. */
export function ContactLeadsTab({ id }: { id: string }) {
  return <LeadList contactId={id} />;
}
