import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  layout('routes/app-layout.tsx', [index('routes/dashboard.tsx')]),
] satisfies RouteConfig;
