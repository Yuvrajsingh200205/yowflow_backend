import { Router } from 'express';
import * as controller from '../controllers/billing.controller';
import { validate } from '../middleware/validate';
import { requirePermission } from '../middleware/rbac';
import { authLimiter } from '../middleware/rateLimiter';
import { idParam } from '../validators/common.validator';
import { checkoutSchema, createApiKeySchema, verifyPaymentSchema } from '../validators/admin.validator';

/** Plan and payment endpoints. Changing a plan needs `ORG_UPDATE`; reading it needs only a session. */
export const billingRouter = Router();
billingRouter.get('/', controller.getBilling);
billingRouter.post('/checkout', requirePermission('ORG_UPDATE'), authLimiter, validate({ body: checkoutSchema }), controller.createCheckout);
billingRouter.post('/verify', requirePermission('ORG_UPDATE'), authLimiter, validate({ body: verifyPaymentSchema }), controller.verifyPayment);

/** Mounted at `/settings/api-keys`. Keys cannot manage keys (enforced in requireAuth). */
export const apiKeyRouter = Router();
apiKeyRouter.get('/', requirePermission('SETTING_UPDATE'), controller.listApiKeys);
apiKeyRouter.post('/', requirePermission('SETTING_UPDATE'), validate({ body: createApiKeySchema }), controller.createApiKey);
apiKeyRouter.delete('/:id', requirePermission('SETTING_UPDATE'), validate({ params: idParam }), controller.revokeApiKey);
