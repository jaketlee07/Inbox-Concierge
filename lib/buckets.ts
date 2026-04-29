export type SystemBucketName = 'Important' | 'Can Wait' | 'Auto-Archive' | 'Newsletter';

export type BucketDefaultAction = 'archive' | 'label' | null;

export interface SystemBucket {
  name: SystemBucketName;
  color: string;
  description: string;
  sortOrder: number;
  badgeClass: string;
  // Mirrors buckets.default_action seeded by handle_new_user(). Drives the
  // client-side optimistic update after an Override.
  defaultAction: BucketDefaultAction;
}

export const SYSTEM_BUCKETS: readonly SystemBucket[] = [
  {
    name: 'Important',
    color: '#ef4444',
    sortOrder: 1,
    description: 'Email I need to read or act on now.',
    badgeClass: 'bg-red-100 text-red-800 border-red-200',
    defaultAction: null,
  },
  {
    name: 'Can Wait',
    color: '#f59e0b',
    sortOrder: 2,
    description: 'Useful but not urgent.',
    badgeClass: 'bg-amber-100 text-amber-800 border-amber-200',
    defaultAction: null,
  },
  {
    name: 'Auto-Archive',
    color: '#10b981',
    sortOrder: 3,
    description: 'Receipts, confirmations, automated notifications.',
    badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    defaultAction: 'archive',
  },
  {
    name: 'Newsletter',
    color: '#3b82f6',
    sortOrder: 4,
    description: 'Subscriptions and digests.',
    badgeClass: 'bg-blue-100 text-blue-800 border-blue-200',
    defaultAction: 'archive',
  },
] as const;

const SYSTEM_BUCKET_NAMES = new Set<string>(SYSTEM_BUCKETS.map((b) => b.name));

export function isSystemBucketName(name: string): name is SystemBucketName {
  return SYSTEM_BUCKET_NAMES.has(name);
}
