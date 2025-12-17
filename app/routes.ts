import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  layout('routes/app-layout.tsx', [
    index('routes/dashboard.tsx'),
    route('projects', 'routes/projects.tsx'),
    route('projects/new', 'routes/project-new.tsx'),
    route('projects/:projectId', 'routes/project-layout.tsx', [
      index('routes/project-overview.tsx'),
    ]),
  ]),
] satisfies RouteConfig;
