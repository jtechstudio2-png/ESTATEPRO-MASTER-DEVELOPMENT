import { getRequestConfig } from 'next-intl/server';

import { pageContext } from '@/server/context';
import { loadMessages } from '@/messages/load';

/** Interface language and formatting locale come from the member's context (W-D5). */
export default getRequestConfig(async () => {
  const context = await pageContext();
  const messages = await loadMessages(context.language);
  return {
    locale: context.language,
    messages,
    timeZone: context.session?.timezone ?? 'UTC',
    formats: {},
  };
});
