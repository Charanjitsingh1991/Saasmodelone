import { useCallback, useEffect, useState } from 'react';
import type { ContextResponse, SessionResponse } from '@saasmodels/contracts';
import { api, setCsrfToken, setUnauthorizedListener } from './api';
import { AppShell } from './components/AppShell';
import { LoginScreen } from './components/LoginScreen';
import {
  ContentScreen,
  ModuleAccessState,
  MoneyScreen,
  WorkScreen,
} from './components/ModuleScreens';
import {
  HomeScreen,
  NotFoundScreen,
  PeopleAccessState,
  PeopleScreen,
} from './components/Screens';
import { BlockedState, BootState, OfflineState } from './components/States';
import { canReadModule, canReadPeople, landingPath } from './lib/model';
import { moduleScreenPath, parseRoute, routeTitle, type Route } from './lib/router';
import { applyTheme, currentTheme, type Theme } from './lib/theme';

type BootPhase = 'loading' | 'anonymous' | 'ready' | 'blocked' | 'offline';

export function App() {
  const [boot, setBoot] = useState<BootPhase>('loading');
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [blockedCode, setBlockedCode] = useState<string | null>(null);
  const [path, setPath] = useState(() => window.location.pathname);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());

  const route: Route = parseRoute(path);

  const navigate = useCallback((to: string, replace = false) => {
    if (window.location.pathname !== to) {
      if (replace) {
        window.history.replaceState(null, '', to);
      } else {
        window.history.pushState(null, '', to);
      }
    }
    setPath(to);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const handlePop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  const enter = useCallback(
    async (session: SessionResponse) => {
      setCsrfToken(session.csrfToken);
      const result = await api.context();
      if (!result.ok) {
        if (result.status === 401) {
          setCsrfToken(null);
          setBoot('anonymous');
          navigate('/login', true);
          return;
        }
        if (result.status === 403) {
          setBlockedCode(result.code);
          setBoot('blocked');
          return;
        }
        setBoot('offline');
        return;
      }
      setContext(result.data);
      setBoot('ready');
      // A signed-in reload of a module route keeps that route, and the home
      // route stays the home route. Sign-in starts from the login route and
      // lands on the first module that has a screen.
      const requested = parseRoute(window.location.pathname);
      const destination =
        requested.name === 'home'
          ? '/app'
          : requested.name === 'login' || requested.name === 'not-found'
            ? landingPath(result.data)
            : (moduleScreenPath(requested.name) ?? landingPath(result.data));
      navigate(destination, true);
    },
    [navigate],
  );

  const bootApp = useCallback(async () => {
    setBoot('loading');
    setContext(null);
    const session = await api.session();
    if (!session.ok) {
      if (session.status === 401) {
        setBoot('anonymous');
        navigate('/login', true);
        return;
      }
      if (session.status === 403) {
        setBlockedCode(session.code);
        setBoot('blocked');
        return;
      }
      setBoot('offline');
      return;
    }
    await enter(session.data);
  }, [enter, navigate]);

  useEffect(() => {
    void bootApp();
  }, [bootApp]);

  // Any 401 outside the login form means the session is gone. Clear all
  // in-memory authorization state and return to sign-in.
  useEffect(() => {
    setUnauthorizedListener(() => {
      setCsrfToken(null);
      setContext(null);
      setBoot('anonymous');
      navigate('/login', true);
    });
    return () => setUnauthorizedListener(null);
  }, [navigate]);

  useEffect(() => {
    if (boot === 'ready' && context && route.name === 'login') {
      navigate(landingPath(context), true);
    }
    if (boot === 'anonymous' && route.name !== 'login') {
      navigate('/login', true);
    }
  }, [boot, context, route.name, navigate]);

  useEffect(() => {
    document.title = routeTitle(parseRoute(path));
    document.getElementById('main')?.focus();
  }, [path, boot]);

  const signOut = useCallback(async () => {
    await api.logout();
    setCsrfToken(null);
    setContext(null);
    setBoot('anonymous');
    navigate('/login', true);
  }, [navigate]);

  function changeTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  if (boot === 'loading') {
    return <BootState />;
  }

  if (boot === 'offline') {
    return <OfflineState onRetry={() => void bootApp()} />;
  }

  if (boot === 'blocked') {
    return <BlockedState code={blockedCode} onSignOut={signOut} />;
  }

  if (boot === 'anonymous' || !context) {
    return (
      <LoginScreen
        onEnter={enter}
        onBlocked={(code) => {
          setBlockedCode(code);
          setBoot('blocked');
        }}
      />
    );
  }

  if (route.name === 'login') {
    return <BootState />;
  }

  const page =
    route.name === 'people' ? (
      canReadPeople(context) ? (
        <PeopleScreen context={context} />
      ) : (
        <PeopleAccessState context={context} onNavigate={navigate} />
      )
    ) : route.name === 'work' ? (
      canReadModule(context, 'work') ? (
        <WorkScreen context={context} />
      ) : (
        <ModuleAccessState
          context={context}
          moduleName="Work"
          onNavigate={navigate}
        />
      )
    ) : route.name === 'money' ? (
      canReadModule(context, 'money') ? (
        <MoneyScreen context={context} />
      ) : (
        <ModuleAccessState
          context={context}
          moduleName="Money"
          onNavigate={navigate}
        />
      )
    ) : route.name === 'content' ? (
      canReadModule(context, 'content') ? (
        <ContentScreen context={context} />
      ) : (
        <ModuleAccessState
          context={context}
          moduleName="Content"
          onNavigate={navigate}
        />
      )
    ) : route.name === 'home' ? (
      <HomeScreen context={context} onNavigate={navigate} />
    ) : (
      <NotFoundScreen onNavigate={navigate} />
    );

  return (
    <AppShell
      context={context}
      theme={theme}
      routeName={route.name}
      onNavigate={navigate}
      onThemeChange={changeTheme}
      onSignOut={signOut}
    >
      {page}
    </AppShell>
  );
}
