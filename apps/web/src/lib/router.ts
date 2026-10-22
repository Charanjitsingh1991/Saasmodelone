export type Route =
  | { name: 'login' }
  | { name: 'home' }
  | { name: 'people' }
  | { name: 'not-found'; path: string };

export function parseRoute(pathname: string): Route {
  if (pathname === '/login' || pathname === '/login/') {
    return { name: 'login' };
  }
  if (pathname === '/app' || pathname === '/app/') {
    return { name: 'home' };
  }
  if (pathname === '/app/people' || pathname === '/app/people/') {
    return { name: 'people' };
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
    default:
      return 'Not found — SaaSModels One';
  }
}
