import { ContactSalesTab } from '@/components/sales/record-panels';

export default async function ContactSalesTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactSalesTab id={id} />;
}
