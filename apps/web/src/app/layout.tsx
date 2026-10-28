import '@/styles/globals.css';

import type { Metadata, Viewport } from 'next';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { pageContext } from '@/server/context';

export const metadata: Metadata = {
  title: { default: 'EstatePro', template: '%s · EstatePro' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export const dynamic = 'force-dynamic';

/** Language and direction come from the member's locale (UI checklist §9). */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const context = await pageContext();
  const messages = await getMessages();
  return (
    <html lang={context.language} dir={context.direction}>
      <body>
        <Providers
          locale={context.locale}
          language={context.language}
          timeZone={context.session?.timezone ?? 'UTC'}
          messages={messages}
          csrfToken={context.csrfToken}
          companyId={context.session?.company.id ?? null}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
