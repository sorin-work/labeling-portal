import { requireUser } from '~/lib/auth.server';
import { labelExport } from '~/models/label-export.server';

import type { Route } from './+types/project-download';

/** The label download of the export page. `labelExport` has the rules. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireUser(request);
  return labelExport(current, params.projectId, request);
}
