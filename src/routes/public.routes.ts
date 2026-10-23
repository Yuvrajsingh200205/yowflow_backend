import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { contactSchema } from '../validators/auth.validator';
import * as controller from '../controllers/auth.controller';
import * as sales from '../controllers/sales.controller';
import { publicAcceptSchema, publicDeclineSchema, publicEnquirySchema, publicMessageSchema, publicRangeQuery, publicSelectionSchema, slugParam, tokenParam } from '../validators/sales.validator';

/** Anonymous marketing-site endpoints. Everything here is rate-limited and stores nothing sensitive. */
const router = Router();

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest || env.isDevelopment,
  handler: (_req, res) =>
    res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many messages. Please try again later.', details: [], requestId: res.locals.requestId } }),
});

router.post('/contact', contactLimiter, validate({ body: contactSchema }), controller.contact);

const limiter = (windowMs: number, limit: number, message: string) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => env.isTest || env.isDevelopment,
  handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message, details: [], requestId: res.locals.requestId } }),
});
const readLimiter = limiter(60_000, 120, 'Too many requests. Please slow down.');
const enquiryLimiter = limiter(60 * 60_000, 12, 'Too many enquiries from this connection. Please try again later.');
const actionLimiter = limiter(60 * 60_000, 40, 'Too many attempts. Please try again later.');

// A studio's booking page: what it offers, which dates are free, and the enquiry itself.
router.get('/enquiry/:slug', readLimiter, validate({ params: slugParam }), sales.publicPage);
router.get('/enquiry/:slug/availability', readLimiter, validate({ params: slugParam, query: publicRangeQuery }), sales.publicAvailability);
router.post('/enquiry/:slug', enquiryLimiter, validate({ params: slugParam, body: publicEnquirySchema }), sales.publicEnquiry);

// A quotation the studio sent: the token in the link is the credential.
router.get('/quotes/:token', readLimiter, validate({ params: tokenParam }), sales.publicQuoteGet);
router.get('/quotes/:token/pdf', readLimiter, validate({ params: tokenParam }), sales.publicQuotePdf);
router.post('/quotes/:token/price', readLimiter, validate({ params: tokenParam, body: publicSelectionSchema }), sales.publicQuotePrice);
router.post('/quotes/:token/accept', actionLimiter, validate({ params: tokenParam, body: publicAcceptSchema }), sales.publicQuoteAccept);
router.post('/quotes/:token/decline', actionLimiter, validate({ params: tokenParam, body: publicDeclineSchema }), sales.publicQuoteDecline);
router.post('/quotes/:token/message', actionLimiter, validate({ params: tokenParam, body: publicMessageSchema }), sales.publicQuoteMessage);

export default router;
