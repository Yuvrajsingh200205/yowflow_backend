import { env } from './env';

/**
 * Single source of truth for the product identity on the API side. Everything
 * customer-visible (API title, PDFs, cookie names) derives from here, and the
 * values come from BRAND_* environment variables.
 */
export const brand = {
  name: env.brandName,
  /** URL/log/JWT-safe form of the name, e.g. "Frame Loom" -> "frame-loom". */
  slug: env.brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  supportEmail: env.brandSupportEmail,
  cookiePrefix: env.brandCookiePrefix,
  cookie: {
    access: `${env.brandCookiePrefix}_access_token`,
    refresh: `${env.brandCookiePrefix}_refresh_token`,
    freelancerAccess: `${env.brandCookiePrefix}_freelancer_access_token`,
    freelancerRefresh: `${env.brandCookiePrefix}_freelancer_refresh_token`,
    portalAccess: `${env.brandCookiePrefix}_portal_access_token`,
    portalRefresh: `${env.brandCookiePrefix}_portal_refresh_token`,
  },
} as const;
