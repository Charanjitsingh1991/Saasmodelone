import { useState, type MouseEvent, type ReactNode } from 'react';
import type { ContextResponse } from '@saasmodels/contracts';
import {
  accessLabel,
  navigationModules,
  roleLabel,
} from '../lib/model';
import { nextTheme, type Theme } from '../lib/theme';
import { Brand } from './Brand';

type AppShellProps = {
  context: ContextResponse;
  theme: Theme;
  routeName: 'home' | 'people' | 'not-found';
  onNavigate: (path: string) => void;
  onThemeChange: (theme: Theme) => void;
  onSignOut: () => Promise<void>;
  children: ReactNode;
};

export function AppShell({
  context,
  theme,
  routeName,
  onNavigate,
  onThemeChange,
  onSignOut,
  children,
}: AppShellProps) {
  const [signingOut, setSigningOut] = useState(false);
  const modules = navigationModules(context);

  function follow(event: MouseEvent<HTMLAnchorElement>, path: string) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onNavigate(path);
  }

  async function handleSignOut() {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    await onSignOut();
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="topbar">
        <a
          className="brand-link"
          href="/app"
          onClick={(event) => follow(event, '/app')}
        >
          <Brand />
        </a>

        <div className="topbar-meta">
          <span className="role-chip">{roleLabel(context.role)}</span>
          <button
            type="button"
            className="theme-toggle"
            aria-label="Dark theme"
            aria-pressed={theme === 'dark'}
            onClick={() => onThemeChange(nextTheme(theme))}
          >
            <span className="theme-glyph" aria-hidden="true" />
            <span className="theme-text">{theme === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
          <button
            type="button"
            className="button button--quiet button--small"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <div className="shell-grid">
        <nav className="module-nav" aria-label="Modules">
          <p className="nav-label">Modules</p>
          {modules.map((module) => {
            const state = accessLabel(module);
            if (module.code === 'people') {
              return (
                <a
                  key={module.code}
                  className="nav-item"
                  href="/app/people"
                  aria-current={routeName === 'people' ? 'page' : undefined}
                  onClick={(event) => follow(event, '/app/people')}
                >
                  <span className="nav-name">{module.name}</span>
                  <span className="nav-state">{state}</span>
                </a>
              );
            }
            return (
              <div
                key={module.code}
                className="nav-item nav-item--pending"
                aria-disabled="true"
              >
                <span className="nav-name">{module.name}</span>
                <span className="nav-tag">Soon</span>
              </div>
            );
          })}
        </nav>

        <main id="main" tabIndex={-1} className="content">
          {children}
        </main>
      </div>
    </div>
  );
}
