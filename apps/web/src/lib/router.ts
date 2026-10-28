// The one map from a module code to the screen that module has. Navigation and
// the landing path both read it, so a module can never be a link in one place
// and a pending item in another, and a route can never exist for a module that
// the navigation does not offer.
export const MODULE_SCREENS = {
  people: '/app/people',
  crm: '/app/crm',
  work: '/app/work',
  money: '/app/money',
  content: '/app/content',
} as const;

export type ModuleRouteName = keyof typeof MODULE_SCREENS;

export type Route =
  | { name: 'login' }
  | { name: 'home' }
  | { name: ModuleRouteName }
  | { name: 'not-found'; path: string };

// The screen a module code has, or null when the module has no screen yet and
// its navigation entry stays a pending item.
export function moduleScreenPath(code: string): string | null {
  return Object.hasOwn(MODULE_SCREENS, code)
    ? MODULE_SCREENS[code as ModuleRouteName]
    : null;
}

export function parseRoute(pathname: string): Route {
  if (pathname === '/login' || pathname === '/login/') {
    return { name: 'login' };
  }
  if (pathname === '/app' || pathname === '/app/') {
    return { name: 'home' };
  }
  for (const name of Object.keys(MODULE_SCREENS) as ModuleRouteName[]) {
    const path = MODULE_SCREENS[name];
    if (pathname === path || pathname === `${path}/`) {
      return { name };
    }
  }
  return { name: 'not-found', path: pathname };
}

export function routeTitle(route: Route): string {
  switch (route.name) {
    case 'login':
      return 'Sign in — SaaSModels One';
    case 'home':
      return 'Workspace — SaaSModels One';
    case 'people':
      return 'People — SaaSModels One';
    case 'crm':
      return 'CRM — SaaSModels One';
    case 'work':
      return 'Work — SaaSModels One';
    case 'money':
      return 'Money — SaaSModels One';
    case 'content':
      return 'Content — SaaSModels One';
    default:
      return 'Not found — SaaSModels One';
  }
}
