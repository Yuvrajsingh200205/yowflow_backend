import type { IncomingMessage, ServerResponse } from 'http';
import { createApp } from '../src/app';
import { logger } from '../src/config/logger';
import { syncPermissionCatalogue } from '../src/services/permissionCatalogue.service';

const app = createApp();

/**
 * A serverless deployment has no boot step, so a release that adds permissions would leave existing studios
 * without them (the new sidebar items would simply never appear). Each new instance therefore checks the catalogue
 * once; when nothing changed that is a single read. A failure is logged and never blocks the request.
 */
let catalogue: Promise<unknown> | null = null;
const ensureCatalogue = () => (catalogue ??= syncPermissionCatalogue({ quietWhenCurrent: true }).catch((error: unknown) => {
  logger.error({ err: error }, 'permission catalogue sync failed');
  catalogue = null;
}));

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ensureCatalogue();
  app(req, res);
}
