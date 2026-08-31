/** Entirely synthetic records. No real people, no real PII, no real credentials. */
export interface Account { code: string; kind: 'savings' | 'checking'; balance: string; opened: string }
export interface Member {
  no: string;
  name: string;
  /** Deliberately unmasked synthetic SSN so we can prove redaction never leaks it. */
  ssn: string;
  branch: string;
  status: string;
  accounts: Account[];
  /** Sub-account form rejects this member (business validation error). */
  subacctBlocked?: string;
}

export const OPERATOR = {
  user: 'svc.agent',
  password: process.env.TARGET_APP_PASSWORD ?? 'Passw0rd!demo',
};

/** Branch the logged-in service account is authorized for. */
export const AUTHORIZED_BRANCH = '004';

export const MEMBERS: Record<string, Member> = {
  '12345': {
    no: '12345', name: 'WHITFIELD, DANA R', ssn: '512-77-8891', branch: '004', status: 'ACTIVE',
    accounts: [
      { code: '0001', kind: 'savings', balance: '4,812.63', opened: '2016-03-11' },
      { code: '0070', kind: 'checking', balance: '1,204.11', opened: '2018-09-02' },
    ],
  },
  '23456': {
    no: '23456', name: 'OYELARAN, MARCUS T', ssn: '404-22-1907', branch: '004', status: 'ACTIVE',
    accounts: [{ code: '0001', kind: 'savings', balance: '150.00', opened: '2021-01-19' }],
  },
  '77777': {
    no: '77777', name: 'RAGHUNATHAN, PRIYA', ssn: '318-90-4416', branch: '004', status: 'ACTIVE',
    accounts: [{ code: '0001', kind: 'savings', balance: '22,940.05', opened: '2009-06-30' }],
    subacctBlocked: 'ERR-2210  SUB-ACCOUNT LIMIT REACHED FOR THIS MEMBER',
  },
  '11111': {
    no: '11111', name: 'CLASSIFIED / RESTRICTED', ssn: '000-00-0000', branch: '019', status: 'ACTIVE',
    accounts: [{ code: '0001', kind: 'savings', balance: '0.00', opened: '2001-01-01' }],
  },
};
