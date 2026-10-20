import { asyncHandler, requireAuthContext } from '../utils/http';
import { sendSuccess } from '../utils/response';
import * as dashboardService from '../services/dashboard.service';

export const summary = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return sendSuccess(res, await dashboardService.getSummary(auth));
});

export const trends = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const months = Number(req.query.months ?? 8);
  return sendSuccess(res, await dashboardService.getTrends(auth, Number.isFinite(months) ? months : 8));
});
