import { Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { asyncHandler, auditContext, requireAuthContext } from '../utils/http';
import { sendCreated, sendNoContent, sendSuccess } from '../utils/response';
import { forbidden, notFound } from '../utils/errors';
import * as catalog from '../services/catalog.service';
import * as setup from '../services/salesSettings.service';
import * as availability from '../services/availability.service';
import * as engine from '../services/quoteEngine.service';
import * as publicQuote from '../services/quotePublic.service';
import * as enquiry from '../services/enquiry.service';
import * as booking from '../services/booking.service';
import * as pdf from '../services/pdf.service';
import * as reminders from '../services/reminders.service';
import * as templates from '../services/templateLibrary.service';
import * as quick from '../services/quickQuote.service';

const pdfResponse = (res: Response, file: { buffer: Buffer; filename: string }) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(file.buffer);
};

// ── Catalogue ───────────────────────────────────────────────────────────────
export const listCatalog = asyncHandler(async (req, res) => sendSuccess(res, await catalog.listCatalog(requireAuthContext(req).organizationId, req.query as never)));
export const createCatalogItem = asyncHandler(async (req, res) => sendCreated(res, await catalog.createCatalogItem(requireAuthContext(req), req.body, auditContext(req))));
export const updateCatalogItem = asyncHandler(async (req, res) => sendSuccess(res, await catalog.updateCatalogItem(requireAuthContext(req), req.params.id, req.body, auditContext(req))));
export const deleteCatalogItem = asyncHandler(async (req, res) => { await catalog.deleteCatalogItem(requireAuthContext(req), req.params.id, auditContext(req)); return sendNoContent(res); });
export const seedCatalog = asyncHandler(async (req, res) => sendCreated(res, await catalog.seedStarterCatalog(requireAuthContext(req), auditContext(req))));

export const listTemplates = asyncHandler(async (req, res) => sendSuccess(res, await templates.listTemplates(requireAuthContext(req).organizationId)));
export const importTemplates = asyncHandler(async (req, res) => sendCreated(res, await templates.importTemplates(requireAuthContext(req), req.body.keys, auditContext(req))));
export const confirmPrices = asyncHandler(async (req, res) => sendSuccess(res, await templates.confirmPrices(requireAuthContext(req), auditContext(req))));

// ── Setup ───────────────────────────────────────────────────────────────────
export const readiness = asyncHandler(async (req, res) => sendSuccess(res, await setup.getReadiness(requireAuthContext(req).organizationId)));
export const getSettings = asyncHandler(async (req, res) => sendSuccess(res, await setup.getSalesSettings(requireAuthContext(req).organizationId)));
export const updateSettings = asyncHandler(async (req, res) => sendSuccess(res, await setup.updateSalesSettings(requireAuthContext(req), req.body, auditContext(req))));
export const getEnquiryPage = asyncHandler(async (req, res) => sendSuccess(res, await setup.getEnquiryPage(requireAuthContext(req).organizationId)));
export const updateEnquiryPage = asyncHandler(async (req, res) => sendSuccess(res, await setup.updateEnquiryPage(requireAuthContext(req), req.body, auditContext(req))));
export const listBlocked = asyncHandler(async (req, res) => sendSuccess(res, await setup.listBlockedDates(requireAuthContext(req).organizationId, req.query.from as string | undefined, req.query.to as string | undefined)));
export const createBlocked = asyncHandler(async (req, res) => sendCreated(res, await setup.createBlockedDate(requireAuthContext(req), req.body, auditContext(req))));
export const deleteBlocked = asyncHandler(async (req, res) => { await setup.deleteBlockedDate(requireAuthContext(req), req.params.id, auditContext(req)); return sendNoContent(res); });
export const calendar = asyncHandler(async (req, res) => sendSuccess(res, await availability.dayStatuses(requireAuthContext(req).organizationId, req.query.from as string, req.query.to as string, { details: true })));
export const checkDate = asyncHandler(async (req, res) => {
  const day = await availability.checkDate(requireAuthContext(req).organizationId, req.query.date as string, { excludeProjectId: req.query.excludeProjectId as string | undefined });
  return sendSuccess(res, { ...day, sellable: availability.isSellable(day.status), reason: availability.reasonFor(day.status) });
});

// ── Quotes (staff) ───
export const quickQuote = asyncHandler(async (req, res) => sendCreated(res, await quick.createQuickQuote(requireAuthContext(req), req.body, auditContext(req))));
export const quoteFromLead = asyncHandler(async (req, res) => sendCreated(res, await engine.createQuoteForLead(requireAuthContext(req), req.body, auditContext(req))));
export const updateQuote = asyncHandler(async (req, res) => sendSuccess(res, await engine.updateQuoteContent(requireAuthContext(req), req.params.id, req.body, auditContext(req))));
export const sendQuote = asyncHandler(async (req, res) => sendSuccess(res, await engine.sendQuote(requireAuthContext(req), req.params.id, req.body, auditContext(req))));
export const quoteEvents = asyncHandler(async (req, res) => sendSuccess(res, await engine.listQuoteEvents(requireAuthContext(req).organizationId, req.params.id)));
export const quotePreview = asyncHandler(async (req, res) => sendSuccess(res, await publicQuote.previewForStaff(requireAuthContext(req), req.params.id)));
export const quotePdf = asyncHandler(async (req, res) => pdfResponse(res, await pdf.createQuotationPdf({ id: req.params.id, organizationId: requireAuthContext(req).organizationId })));
export const invoicePdf = asyncHandler(async (req, res) => pdfResponse(res, await pdf.createInvoicePdf(requireAuthContext(req).organizationId, req.params.id)));
export const todayList = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return sendSuccess(res, await reminders.todayList(auth.organizationId, { payments: auth.permissions.has('PAYMENT_VIEW') }));
});
export const convertQuote = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  if (!auth.permissions.has('PROJECT_CREATE')) throw forbidden('Booking creates a project, which needs the PROJECT_CREATE permission.');
  if (req.body.overrideAvailability && !auth.permissions.has('BOOKING_SETUP_MANAGE')) throw forbidden('Booking over a full or closed date needs the BOOKING_SETUP_MANAGE permission.');
  await engine.assertQuoteBelongs(auth.organizationId, req.params.id);
  return sendSuccess(res, await booking.bookQuotation({ organizationId: auth.organizationId, quotationId: req.params.id, actor: { type: 'STAFF', id: auth.userId }, overrideAvailability: req.body.overrideAvailability }));
});

// ── Public ──────────────────────────────────────────────────────────────────
const meta = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null });
export const publicPage = asyncHandler(async (req, res) => sendSuccess(res, await enquiry.getPublicPage(req.params.slug)));
export const publicAvailability = asyncHandler(async (req, res) => sendSuccess(res, await enquiry.getPublicAvailability(req.params.slug, req.query.from as string, req.query.to as string)));
export const publicEnquiry = asyncHandler(async (req, res) => {
  // A bot filled the hidden field: answer as if it worked, store nothing.
  if (req.body.website) return sendCreated(res, { received: true, message: 'Thank you!', quoteToken: null });
  const { consent: _c, website: _w, ...input } = req.body;
  void _c; void _w;
  return sendCreated(res, await enquiry.submitEnquiry(req.params.slug, input));
});
export const publicQuoteGet = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return sendSuccess(res, await publicQuote.getPublicQuote(req.params.token, { track: req.query.preview !== '1' }));
});
export const publicQuotePrice = asyncHandler(async (req, res) => sendSuccess(res, await publicQuote.previewSelection(req.params.token, req.body.selection)));
export const publicQuoteAccept = asyncHandler(async (req, res) => sendSuccess(res, await publicQuote.acceptPublicQuote(req.params.token, req.body, meta(req))));
export const publicQuoteDecline = asyncHandler(async (req, res) => sendSuccess(res, await publicQuote.declinePublicQuote(req.params.token, req.body)));
export const publicQuoteMessage = asyncHandler(async (req, res) => sendSuccess(res, await publicQuote.messageFromQuote(req.params.token, req.body)));
export const publicQuotePdf = asyncHandler(async (req, res) => pdfResponse(res, await pdf.createQuotationPdf({ publicToken: req.params.token })));

// ── Scheduled job ───────────────────────────────────────────────────────────
export const cronReminders = asyncHandler(async (req, res) => {
  const secret = env.CRON_SECRET;
  if (!secret) throw notFound('Resource');
  const given = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given); const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw forbidden('Invalid job credentials');
  return sendSuccess(res, await reminders.runReminders());
});
