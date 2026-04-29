'use client';

import { useState } from 'react';
import { Lock, Trash2, Plus } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useBuckets, useCreateBucket, useDeleteBucket, type BucketView } from '@/hooks/useBuckets';
import { useClassification } from '@/hooks/useClassification';

interface BucketManagerProps {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BucketManager({ userId, open, onOpenChange }: BucketManagerProps) {
  const buckets = useBuckets(userId);
  const createBucket = useCreateBucket(userId);
  const deleteBucket = useDeleteBucket(userId);
  const classification = useClassification(userId);

  const [name, setName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<BucketView | null>(null);
  const [reassignTarget, setReassignTarget] = useState<string>('');
  const [reclassifyOpen, setReclassifyOpen] = useState(false);

  const list = buckets.data?.buckets ?? [];
  const trimmed = name.trim();
  const isDuplicate = list.some((b) => b.name === trimmed);
  const canAdd = trimmed.length > 0 && !isDuplicate && !createBucket.isPending;

  async function handleAdd() {
    if (!canAdd) return;
    try {
      await createBucket.mutateAsync({ name: trimmed });
      setName('');
      setReclassifyOpen(true);
    } catch {
      // toast already fired in hook
    }
  }

  function openDelete(bucket: BucketView) {
    setPendingDelete(bucket);
    const fallback = list.find((b) => b.id !== bucket.id);
    setReassignTarget(fallback?.name ?? '');
  }

  async function handleDelete() {
    if (!pendingDelete || !reassignTarget) return;
    try {
      await deleteBucket.mutateAsync({
        id: pendingDelete.id,
        reassignToBucketName: reassignTarget,
      });
      setPendingDelete(null);
      setReassignTarget('');
      setReclassifyOpen(true);
    } catch {
      // toast already fired
    }
  }

  function handleReclassify() {
    setReclassifyOpen(false);
    onOpenChange(false);
    void classification.start(true);
  }

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="Manage buckets"
        description="Add or remove custom buckets. Default buckets are read-only."
        size="md"
        footer={
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        }
      >
        {buckets.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <div className="space-y-3">
            <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
              {list.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: b.color }}
                      aria-hidden="true"
                    />
                    <span className="truncate font-medium text-neutral-900">{b.name}</span>
                    {b.isSystem ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-neutral-500">
                        <Lock className="h-3 w-3" aria-hidden="true" />
                        Default
                      </span>
                    ) : (
                      <span className="text-[10px] text-neutral-500 tabular-nums">
                        {b.threadCount} threads
                      </span>
                    )}
                  </div>
                  {!b.isSystem && (
                    <button
                      type="button"
                      onClick={() => openDelete(b)}
                      aria-label={`Delete ${b.name}`}
                      className="rounded p-1 text-neutral-500 hover:bg-red-50 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:outline-none"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>

            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleAdd();
              }}
            >
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Bucket name…"
                maxLength={32}
                className="h-8 flex-1 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:outline-none"
              />
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={!canAdd}
                loading={createBucket.isPending}
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                Add
              </Button>
            </form>
            {isDuplicate && trimmed.length > 0 && (
              <p className="text-xs text-red-700">
                A bucket named &ldquo;{trimmed}&rdquo; already exists.
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={pendingDelete !== null}
        onOpenChange={(v) => {
          if (!v) {
            setPendingDelete(null);
            setReassignTarget('');
          }
        }}
        title={pendingDelete ? `Delete "${pendingDelete.name}"?` : 'Delete bucket?'}
        description={
          pendingDelete && pendingDelete.threadCount > 0
            ? `${pendingDelete.threadCount} threads classified here will move to the bucket you choose below.`
            : 'No threads currently classified here. Pick where future threads in this bucket would have gone.'
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              disabled={!reassignTarget}
              loading={deleteBucket.isPending}
            >
              Delete
            </Button>
          </>
        }
      >
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-700">
            Reassign threads to
          </span>
          <select
            value={reassignTarget}
            onChange={(e) => setReassignTarget(e.target.value)}
            className="h-8 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:outline-none"
          >
            <option value="" disabled>
              Choose a bucket…
            </option>
            {list
              .filter((b) => b.id !== pendingDelete?.id)
              .map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
          </select>
        </label>
      </Modal>

      <Modal
        open={reclassifyOpen}
        onOpenChange={setReclassifyOpen}
        title="Reclassify now?"
        description="Custom buckets only take effect after Claude re-runs over your inbox. Reclassifying may auto-archive or label threads in your Gmail."
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setReclassifyOpen(false)}>
              Skip
            </Button>
            <Button variant="primary" size="sm" onClick={handleReclassify}>
              Reclassify
            </Button>
          </>
        }
      >
        <p className="text-sm text-neutral-600">
          You can also click &ldquo;Reclassify all threads&rdquo; in Settings later.
        </p>
      </Modal>
    </>
  );
}
