/**
 * Two variants of the *same underlying vendor product*, configured differently.
 * This is the stand-in for "hundreds of tenants running ~20 apps, many sharing a
 * vendor product": same flow, different branding / labels / routes / interstitials.
 */
export interface Variant {
  key: string;
  tenantLabel: string;
  brand: string;
  routes: { inquiry: string; subacct: string };
  labels: {
    memberNo: string;
    inquireBtn: string;
    savings: string;
    checking: string;
    subacctBtn: string;
  };
  /** riverbend forces a compliance notice after login — a per-tenant interstitial. */
  forceNoticeAfterLogin: boolean;
}

export const VARIANTS: Record<string, Variant> = {
  base: {
    key: 'base',
    tenantLabel: 'FIRST MERIDIAN FCU',
    brand: 'MERIDIAN CORE  R7.4',
    routes: { inquiry: '/inq/member', subacct: '/svc/subacct' },
    labels: {
      memberNo: 'MBR NO',
      inquireBtn: 'INQUIRE',
      savings: 'REG SAVINGS',
      checking: 'CHECKING',
      subacctBtn: 'OPEN SUB-ACCOUNT',
    },
    forceNoticeAfterLogin: false,
  },
  riverbend: {
    key: 'riverbend',
    tenantLabel: 'RIVERBEND CU',
    brand: 'MERIDIAN CORE  R7.6.2 (riverbend)',
    routes: { inquiry: '/rb/member-lookup', subacct: '/rb/open-subaccount' },
    labels: {
      memberNo: 'MEMBER NUMBER',
      inquireBtn: 'SEARCH',
      savings: 'SAVINGS BALANCE',
      checking: 'SHARE DRAFT',
      subacctBtn: 'CREATE SUB-ACCOUNT',
    },
    forceNoticeAfterLogin: true,
  },
};
