'use client';

import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { signOut } from '@/app/(app)/inbox/actions';
import { useAuthRevoked } from '@/lib/auth/revoked';

export function TokenRevokedModal() {
  const revoked = useAuthRevoked();
  return (
    <Modal
      open={revoked}
      // Non-dismissable: the only valid action is signing in again. Esc and
      // overlay-click are no-ops; the Modal's built-in close X is overridden
      // by the same no-op (Radix calls onOpenChange).
      onOpenChange={() => undefined}
      title="Signed out"
      description="We've lost access to your Gmail. Sign in again to continue."
      size="sm"
      footer={
        <form action={signOut}>
          <Button type="submit" variant="primary" size="sm">
            Sign in again
          </Button>
        </form>
      }
    >
      <p className="text-sm text-neutral-600">
        Your session expired or was revoked. Click below to return to the login page.
      </p>
    </Modal>
  );
}
