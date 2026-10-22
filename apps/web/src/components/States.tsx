import { useState } from 'react';
import { Brand } from './Brand';

export function BootState() {
  return (
    <main id="main" tabIndex={-1} className="boot">
      <div className="boot-card">
        <Brand />
        <h1 className="sr-only">Preparing your workspace</h1>
        <span className="boot-pulse" aria-hidden="true" />
        <p className="boot-text" role="status">
          Preparing your workspace…
        </p>
      </div>
    </main>
  );
}

type OfflineStateProps = {
  onRetry: () => void;
};

export function OfflineState({ onRetry }: OfflineStateProps) {
  return (
    <main id="main" tabIndex={-1} className="standalone">
      <Brand />
      <p className="eyebrow">Connection</p>
      <h1>We cannot reach your workspace.</h1>
      <p className="page-lede">
        The server did not answer. Check your connection, then try again. Your
        session has not been changed by this failure.
      </p>
      <button className="button button--primary" type="button" onClick={onRetry}>
        Try again
      </button>
    </main>
  );
}

type BlockedStateProps = {
  code: string | null;
  onSignOut: () => Promise<void>;
};

export function BlockedState({ code, onSignOut }: BlockedStateProps) {
  const [leaving, setLeaving] = useState(false);

  const detail =
    code === 'MEMBERSHIP_DENIED'
      ? 'Your membership in this workspace is not active. Ask your workspace owner to restore it.'
      : code === 'PLATFORM_ACCESS_DENIED'
        ? 'This workspace is suspended or closed. Ask your workspace owner for help.'
        : 'Your access to this workspace could not be verified. Ask your workspace owner for help.';

  async function handleLeave() {
    if (leaving) {
      return;
    }
    setLeaving(true);
    await onSignOut();
  }

  return (
    <main id="main" tabIndex={-1} className="standalone">
      <Brand />
      <p className="eyebrow">Access</p>
      <h1>Access to this workspace is paused.</h1>
      <p className="page-lede">{detail}</p>
      <button
        className="button button--quiet"
        type="button"
        onClick={() => void handleLeave()}
        disabled={leaving}
      >
        {leaving ? 'Signing out…' : 'Return to sign in'}
      </button>
    </main>
  );
}
