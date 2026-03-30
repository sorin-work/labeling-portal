import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  route('healthz', 'routes/healthz.ts'),
  layout('routes/app-layout.tsx', [
    index('routes/dashboard.tsx'),
    route('projects', 'routes/projects.tsx'),
    route('projects/new', 'routes/project-new.tsx'),
    route('work/:assignmentId', 'routes/work.tsx'),
    route('review/:assignmentId', 'routes/review.tsx'),
    route('my-work', 'routes/my-work.tsx'),
    route('payouts', 'routes/payouts.tsx'),
    route('my-work/:assignmentId', 'routes/my-work-revise.tsx'),
    route('projects/:projectId', 'routes/project-layout.tsx', [
      index('routes/project-overview.tsx'),
      route('batches', 'routes/project-batches.tsx'),
      route('batches/new', 'routes/batch-new.tsx'),
      route('batches/:batchId', 'routes/batch-detail.tsx'),
      route('tasks/:taskId', 'routes/task-detail.tsx'),
      route('members', 'routes/project-members.tsx'),
      route('settings', 'routes/project-settings.tsx'),
      route('work', 'routes/project-work.tsx'),
      route('qualification', 'routes/project-qualification.tsx'),
      route('review', 'routes/project-review.tsx'),
      route('quality', 'routes/project-quality.tsx'),
    ]),
  ]),
] satisfies RouteConfig;
