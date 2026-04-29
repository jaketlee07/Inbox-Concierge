export type SystemBucketName = 'Important' | 'Can Wait' | 'Auto-Archive' | 'Newsletter';

export interface SystemBucket {
  name: SystemBucketName;
  color: string;
  description: string;
  sortOrder: number;
  badgeClass: string;
}

export const SYSTEM_BUCKETS: readonly SystemBucket[] = [
  {
    name: 'Important',
    color: '#ef4444',
    sortOrder: 1,
    description: 'Email I need to read or act on now.',
    badgeClass: 'bg-red-100 text-red-800 border-red-200',
  },
  {
    name: 'Can Wait',
    color: '#f59e0b',
    sortOrder: 2,
    description: 'Useful but not urgent.',
    badgeClass: 'bg-amber-100 text-amber-800 border-amber-200',
  },
  {
    name: 'Auto-Archive',
    color: '#10b981',
    sortOrder: 3,
    description: 'Receipts, confirmations, automated notifications.',
    badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  },
  {
    name: 'Newsletter',
    color: '#3b82f6',
    sortOrder: 4,
    description: 'Subscriptions and digests.',
    badgeClass: 'bg-blue-100 text-blue-800 border-blue-200',
  },
] as const;

const SYSTEM_BUCKET_NAMES = new Set<string>(SYSTEM_BUCKETS.map((b) => b.name));

export function isSystemBucketName(name: string): name is SystemBucketName {
  return SYSTEM_BUCKET_NAMES.has(name);
}
