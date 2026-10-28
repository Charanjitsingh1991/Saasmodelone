import { useState, type FormEvent } from 'react';
import type { SessionResponse } from '@saasmodels/contracts';
import { api } from '../api';
import { loginFailure, type LoginFailure } from '../lib/errors';
import { Brand } from './Brand';

type LoginScreenProps = {
  onEnter: (session: SessionResponse) => Promise<void>;
  onBlocked: (code: string | null) => void;
};

export function LoginScreen({ onEnter, onBlocked }: LoginScreenProps) {
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<LoginFailure | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);
    setFailure(null);

    const result = await api.login({
      tenantSlug: workspace.trim(),
      email: email.trim(),
      password,
    });

    if (!result.ok) {
      if (result.status === 403) {
        onBlocked(result.code);
        return;
      }
      setFailure(loginFailure(result.status === 0 ? null : result.status));
      setPending(false);
      return;
    }

    await onEnter(result.data);
    setPending(false);
  }

  return (
    <main id="main" tabIndex={-1} className="auth">
      <section className="auth-brand" aria-label="About SaaSModels One">
        <div className="auth-brand-top">
          <Brand />
          <p className="eyebrow auth-eyebrow">Workspace access</p>
          <p className="auth-statement">
            One calm home for the people behind the work.
          </p>
          <p className="auth-lede">
            SaaSModels One starts with the people directory and holds the work,
            money and content around it. Access is checked on the server, for
            every request.
          </p>
        </div>
        <ul className="auth-points">
          <li>
            <span className="point-index">01</span>
            <span>
              <strong>One shared directory</strong>
              Person and client identity live in the platform, not in separate
              modules.
            </span>
          </li>
          <li>
            <span className="point-index">02</span>
            <span>
              <strong>Server-checked access</strong>
              Entitlement and role are enforced before a request reaches data.
            </span>
          </li>
          <li>
            <span className="point-index">03</span>
            <span>
              <strong>Audit by design</strong>
              Tenant isolation in the database and an append-only audit trail.
            </span>
          </li>
        </ul>
        <p className="fine-print">Pre-launch workspace · M0</p>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">Sign in</p>
          <h1 className="auth-title">Enter your workspace</h1>
          <p className="auth-sub">
            Use the workspace slug and credentials your administrator
            provided.
          </p>

          <form className="auth-form" onSubmit={handleSubmit} aria-busy={pending}>
            <div className="field">
              <label htmlFor="workspace">Workspace slug</label>
              <input
                id="workspace"
                name="workspace"
                type="text"
                autoComplete="organization"
                autoCapitalize="none"
                spellCheck={false}
                minLength={3}
                maxLength={63}
                required
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
              />
              <p className="field-hint">The short name for your organisation.</p>
            </div>

            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={320}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            {failure ? (
              <p className="form-alert" role="alert">
                {failure.message}
              </p>
            ) : null}

            <button className="button button--primary" type="submit" disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="auth-help">
            Need an account? Ask your workspace owner for an invitation.
          </p>
        </div>
      </section>
    </main>
  );
}
