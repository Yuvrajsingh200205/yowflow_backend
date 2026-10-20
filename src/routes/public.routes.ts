import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { validate } from '../middleware/validate';
import { contactSchema } from '../validators/auth.validator';
import * as controller from '../controllers/auth.controller';

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

export default router;
