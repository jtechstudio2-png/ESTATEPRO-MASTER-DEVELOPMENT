/** GET /api/v1/me/context (M6 API gap A-1). */
export interface Grant {
  key: string;
  scope: 'all' | 'office' | 'team' | 'own' | 'linked' | 'assigned';
  isSensitive: boolean;
}

export interface SessionContext {
  user: { id: string; displayName: string; email: string };
  company: { id: string; name: string; status: string; baseCurrencyCode: string; headquartersCountryCode: string };
  membershipId: string;
  roleKey: string;
  roleName: string;
  officeIds: string[];
  permissions: Grant[];
  locale: string;
  textDirection: 'ltr' | 'rtl';
  timezone: string;
}

/** GET /api/v1/me */
export interface MeResponse {
  id: string;
  email: string;
  displayName: string;
  memberships: Array<{
    membershipId: string;
    companyId: string;
    companyName: string;
    companyStatus: string;
    roleKey: string;
    roleName: string;
    membershipType: 'staff' | 'portal';
  }>;
}

/** The interface languages with message files (W-D5). */
export const UI_LANGUAGES = ['en', 'ar'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export function uiLanguage(locale: string): UiLanguage {
  const base = locale.split('-')[0];
  return base === 'ar' ? 'ar' : 'en';
}
