import { NotesTab } from '@/components/notes/notes-tab';

export default async function PropertyNotesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NotesTab propertyId={id} />;
}
