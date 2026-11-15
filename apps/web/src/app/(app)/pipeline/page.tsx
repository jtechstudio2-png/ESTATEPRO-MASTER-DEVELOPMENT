import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PipelineBoard } from '@/components/sales/pipeline-board';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('sales'))('pipelineTitle') };
}

export default function PipelinePage() {
  return <PipelineBoard />;
}
