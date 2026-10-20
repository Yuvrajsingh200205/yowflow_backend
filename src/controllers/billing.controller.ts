import { asyncHandler, auditContext, requireAuthContext } from '../utils/http';
import { sendCreated, sendSuccess } from '../utils/response';
import * as billingService from '../services/billing.service';
import * as apiKeyService from '../services/apiKey.service';

export const getBilling = asyncHandler(async (req, res) => sendSuccess(res, await billingService.getBilling(requireAuthContext(req))));
export const createCheckout = asyncHandler(async (req, res) => sendSuccess(res, await billingService.createCheckout(requireAuthContext(req), req.body)));
export const verifyPayment = asyncHandler(async (req, res) =>
  sendSuccess(res, await billingService.verifyPayment(requireAuthContext(req), req.body, auditContext(req))),
);

export const listApiKeys = asyncHandler(async (req, res) => sendSuccess(res, await apiKeyService.listApiKeys(requireAuthContext(req))));
export const createApiKey = asyncHandler(async (req, res) =>
  sendCreated(res, await apiKeyService.createApiKey(requireAuthContext(req), req.body, auditContext(req))),
);
export const revokeApiKey = asyncHandler(async (req, res) => {
  await apiKeyService.revokeApiKey(requireAuthContext(req), req.params.id, auditContext(req));
  return sendSuccess(res, { revoked: true });
});
