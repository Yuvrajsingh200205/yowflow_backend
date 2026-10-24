import { ProjectType } from '@prisma/client';

/**
 * Ready-made packages and add-ons a studio can add to its price list in one tap, so nobody starts from a blank page.
 *
 * The prices are examples. They are marked as such when added, and the app asks the studio to check them before
 * anything goes to a customer. `key` is stable: it is how we remember what was already added, even after a rename.
 */

export interface TemplateGroup {
  id: string;
  /** Shown to the studio, and stored as the item's category. */
  label: string;
  /** What the customer's event is called in the system. The first one is used when a quote is made for this group. */
  eventTypes: ProjectType[];
  blurb: string;
}

export interface TemplateItem {
  key: string;
  group: string;
  kind: 'PACKAGE' | 'ADDON';
  name: string;
  description: string;
  inclusions?: string[];
  pricingType?: 'FIXED' | 'PER_DAY' | 'PER_PERSON';
  unitPrice: number;
  unitLabel?: string;
  taxRate?: number;
  allowQuantity?: boolean;
  minQuantity?: number;
  maxQuantity?: number;
  isPopular?: boolean;
  /** Part of the set every new studio starts with. */
  inDefaultKit?: boolean;
}

export const TEMPLATE_GROUPS: TemplateGroup[] = [
  { id: 'wedding', label: 'Wedding', eventTypes: ['WEDDING', 'COMPLETE_WEDDING_SERVICES'], blurb: 'The main wedding day, priced per day of coverage.' },
  { id: 'prewedding', label: 'Pre-wedding', eventTypes: ['PRE_WEDDING'], blurb: 'Couple shoots before the wedding.' },
  { id: 'engagement', label: 'Engagement & Roka', eventTypes: ['ENGAGEMENT', 'ROKA'], blurb: 'Roka, ring ceremony and engagement.' },
  { id: 'haldi', label: 'Haldi & Mehendi', eventTypes: ['HALDI_MEHENDI'], blurb: 'Smaller functions around the wedding.' },
  { id: 'sangeet', label: 'Sangeet & Reception', eventTypes: ['SANGEET', 'RECEPTION'], blurb: 'Evening functions and receptions.' },
  { id: 'birthday', label: 'Birthday & Kids', eventTypes: ['OTHER'], blurb: 'Birthday parties and kids’ shoots.' },
  { id: 'family', label: 'Baby & Family', eventTypes: ['OTHER'], blurb: 'Maternity, newborn, baby shower and family portraits.' },
  { id: 'anniversary', label: 'Anniversary', eventTypes: ['ANNIVERSARY'], blurb: 'Anniversary celebrations.' },
  { id: 'corporate', label: 'Corporate & Events', eventTypes: ['CORPORATE'], blurb: 'Company events, conferences and headshots.' },
  { id: 'commercial', label: 'Product & Portfolio', eventTypes: ['OTHER'], blurb: 'Product, property and portfolio shoots.' },
  { id: 'addons', label: 'Add-ons', eventTypes: [], blurb: 'Extras a customer can add to any package.' },
];

const DELIVERY = 'Online gallery with a private link';

export const TEMPLATE_ITEMS: TemplateItem[] = [
  // ── Wedding ──────────────────────────────────────────────────────────────
  { key: 'wedding-essentials', group: 'wedding', kind: 'PACKAGE', name: 'Wedding Essentials', description: 'Everything you need to remember the day, beautifully delivered.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 45000, inDefaultKit: true,
    inclusions: ['1 candid photographer', '1 traditional photographer', '300+ edited photographs', DELIVERY, 'Delivery in 21 days'] },
  { key: 'wedding-signature', group: 'wedding', kind: 'PACKAGE', name: 'Wedding Signature', description: 'Photographs and a cinematic highlight film.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 85000, isPopular: true, inDefaultKit: true,
    inclusions: ['2 candid photographers', '1 traditional photographer', '1 cinematographer', '500+ edited photographs', '4–6 minute highlight film', 'Premium album (30 spreads)', DELIVERY] },
  { key: 'wedding-cinematic', group: 'wedding', kind: 'PACKAGE', name: 'Wedding Cinematic', description: 'The full production: team, drone, film and album.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 150000, inDefaultKit: true,
    inclusions: ['3 photographers', '2 cinematographers', 'Drone coverage', '800+ edited photographs', 'Cinematic film (8–10 minutes) + teaser', 'Two premium albums', 'Same-week sneak peeks'] },
  { key: 'wedding-photo-only', group: 'wedding', kind: 'PACKAGE', name: 'Wedding Photography Only', description: 'Photographs only, no film. A good fit for a tighter budget.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 30000,
    inclusions: ['1 photographer', '200+ edited photographs', DELIVERY, 'Delivery in 30 days'] },
  { key: 'wedding-video-only', group: 'wedding', kind: 'PACKAGE', name: 'Wedding Video Only', description: 'Full-day video with a highlight film.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 40000,
    inclusions: ['1 cinematographer', '3–4 minute highlight film', 'Full ceremony recording', 'Delivery in 30 days'] },

  // ── Pre-wedding ──────────────────────────────────────────────────────────
  { key: 'prewedding-photo', group: 'prewedding', kind: 'PACKAGE', name: 'Pre-wedding Photo Shoot', description: 'A relaxed half-day shoot for the couple.', unitPrice: 20000, inDefaultKit: true,
    inclusions: ['Half-day shoot, 1 location', '40 edited photographs', 'Online gallery with a private link'] },
  { key: 'prewedding-photo-film', group: 'prewedding', kind: 'PACKAGE', name: 'Pre-wedding Photo + Film', description: 'Photographs and a short film from the same shoot.', unitPrice: 45000, isPopular: true, inDefaultKit: true,
    inclusions: ['Full-day shoot, up to 2 locations', '60 edited photographs', '2–3 minute love-story film', 'Online gallery with a private link'] },
  { key: 'prewedding-save-the-date', group: 'prewedding', kind: 'PACKAGE', name: 'Save-the-date Video', description: 'A short video for the invitation.', unitPrice: 15000,
    inclusions: ['Half-day shoot', '30–60 second video', 'Vertical version for WhatsApp and Instagram'] },

  // ── Engagement & Roka ────────────────────────────────────────────────────
  { key: 'engagement-photo', group: 'engagement', kind: 'PACKAGE', name: 'Engagement / Roka Photography', description: 'Coverage of the ceremony with edited photographs.', unitPrice: 15000, inDefaultKit: true,
    inclusions: ['Up to 4 hours', '1 photographer', '150 edited photographs', DELIVERY] },
  { key: 'engagement-photo-video', group: 'engagement', kind: 'PACKAGE', name: 'Engagement Photo + Video', description: 'Photographs and a highlight video of the ceremony.', unitPrice: 30000,
    inclusions: ['Up to 4 hours', '1 photographer + 1 videographer', '150 edited photographs', '2–3 minute highlight video', DELIVERY] },

  // ── Haldi & Mehendi ──────────────────────────────────────────────────────
  { key: 'haldi-mehendi-photo', group: 'haldi', kind: 'PACKAGE', name: 'Haldi / Mehendi Coverage', description: 'Half-day coverage of one function.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 15000, inDefaultKit: true,
    inclusions: ['Up to 4 hours', '1 photographer', '100+ edited photographs', DELIVERY] },
  { key: 'haldi-mehendi-video', group: 'haldi', kind: 'PACKAGE', name: 'Haldi + Mehendi with Video', description: 'Both functions with photographs and a highlight video.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 28000,
    inclusions: ['Up to 6 hours', '1 photographer + 1 videographer', '200 edited photographs', '2–3 minute highlight video'] },

  // ── Sangeet & Reception ──────────────────────────────────────────────────
  { key: 'sangeet-coverage', group: 'sangeet', kind: 'PACKAGE', name: 'Sangeet Coverage', description: 'The evening of dance and performances.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 25000,
    inclusions: ['Up to 5 hours', '1 photographer + 1 videographer', '200+ edited photographs', 'Highlight video'] },
  { key: 'reception-photo-video', group: 'sangeet', kind: 'PACKAGE', name: 'Reception Photo + Video', description: 'Stage, family portraits and the whole evening.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 40000,
    inclusions: ['Up to 5 hours', '2 photographers + 1 videographer', '300+ edited photographs', '3–4 minute highlight video', DELIVERY] },

  // ── Birthday & Kids ──────────────────────────────────────────────────────
  { key: 'birthday-party', group: 'birthday', kind: 'PACKAGE', name: 'Birthday Party Coverage', description: 'Candid coverage of the party.', unitPrice: 12000, inDefaultKit: true,
    inclusions: ['Up to 3 hours', '1 photographer', '100+ edited photographs', DELIVERY] },
  { key: 'birthday-photo-video', group: 'birthday', kind: 'PACKAGE', name: 'Birthday Photo + Video', description: 'Photographs and a short highlight video.', unitPrice: 22000,
    inclusions: ['Up to 3 hours', '1 photographer + 1 videographer', '100+ edited photographs', '1–2 minute highlight video'] },
  { key: 'kids-shoot', group: 'birthday', kind: 'PACKAGE', name: 'Kids Photo Shoot', description: 'A studio or outdoor shoot for children.', unitPrice: 8000,
    inclusions: ['1-hour shoot', '2 outfit changes', '25 edited photographs'] },

  // ── Baby & Family ────────────────────────────────────────────────────────
  { key: 'maternity-shoot', group: 'family', kind: 'PACKAGE', name: 'Maternity Shoot', description: 'A comfortable shoot for the parents-to-be.', unitPrice: 10000,
    inclusions: ['1–2 hour shoot', '2 outfit changes', '30 edited photographs'] },
  { key: 'newborn-shoot', group: 'family', kind: 'PACKAGE', name: 'Newborn Shoot', description: 'A gentle shoot with props, best done in the first 3 weeks.', unitPrice: 12000,
    inclusions: ['2–3 hour shoot', 'Props and setups', '25 edited photographs'] },
  { key: 'baby-shower', group: 'family', kind: 'PACKAGE', name: 'Baby Shower Coverage', description: 'Coverage of the function.', unitPrice: 15000,
    inclusions: ['Up to 3 hours', '1 photographer', '100+ edited photographs', DELIVERY] },
  { key: 'family-portrait', group: 'family', kind: 'PACKAGE', name: 'Family Portrait Session', description: 'A short session for the whole family.', unitPrice: 5000,
    inclusions: ['1-hour session', '15 edited photographs'] },

  // ── Anniversary ──────────────────────────────────────────────────────────
  { key: 'anniversary-coverage', group: 'anniversary', kind: 'PACKAGE', name: 'Anniversary Coverage', description: 'Photographs of the celebration.', unitPrice: 12000,
    inclusions: ['Up to 3 hours', '1 photographer', '100+ edited photographs', DELIVERY] },

  // ── Corporate & Events ───────────────────────────────────────────────────
  { key: 'corporate-event', group: 'corporate', kind: 'PACKAGE', name: 'Corporate Event Coverage', description: 'Photographs of a company event.', unitPrice: 25000, inDefaultKit: true,
    inclusions: ['Up to 4 hours', '1 photographer', '150+ edited photographs', 'Delivery in 5 days'] },
  { key: 'conference-day', group: 'corporate', kind: 'PACKAGE', name: 'Conference / Seminar', description: 'Full-day photo and video coverage.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 40000,
    inclusions: ['Full day', '1 photographer + 1 videographer', '300+ edited photographs', 'Highlight video'] },
  { key: 'corporate-headshots', group: 'corporate', kind: 'PACKAGE', name: 'Team Headshots', description: 'Professional portraits, charged per person.', pricingType: 'PER_PERSON', unitLabel: 'person', unitPrice: 800, minQuantity: 10,
    inclusions: ['2 edited photographs per person', 'Backdrop and lighting', 'Delivery in 3 days'] },

  // ── Product & Portfolio ──────────────────────────────────────────────────
  { key: 'product-day', group: 'commercial', kind: 'PACKAGE', name: 'Product Photography (day)', description: 'A day of product shooting at your place or the studio.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 15000,
    inclusions: ['Up to 8 hours', 'Up to 25 products', 'Edited, background-cleaned images'] },
  { key: 'property-shoot', group: 'commercial', kind: 'PACKAGE', name: 'Property / Interior Shoot', description: 'Photographs for a home, shop or office.', unitPrice: 8000,
    inclusions: ['Up to 3 hours', '30 edited photographs'] },
  { key: 'portfolio-shoot', group: 'commercial', kind: 'PACKAGE', name: 'Portfolio / Fashion Shoot', description: 'A portfolio shoot with outfit changes.', unitPrice: 12000,
    inclusions: ['2-hour shoot', '3 looks', '30 edited photographs'] },

  // ── Add-ons ──────────────────────────────────────────────────────────────
  { key: 'addon-drone', group: 'addons', kind: 'ADDON', name: 'Drone coverage', description: 'Aerial shots of the venue and baraat.', unitPrice: 12000, inDefaultKit: true },
  { key: 'addon-prewedding', group: 'addons', kind: 'ADDON', name: 'Pre-wedding shoot', description: 'Half-day outdoor shoot with 50 edited photographs.', unitPrice: 25000, inDefaultKit: true },
  { key: 'addon-album-copy', group: 'addons', kind: 'ADDON', name: 'Extra album copy', description: 'Matching copy for parents (30 spreads).', unitPrice: 8000, allowQuantity: true, minQuantity: 1, maxQuantity: 6, unitLabel: 'copy', inDefaultKit: true },
  { key: 'addon-same-day-edit', group: 'addons', kind: 'ADDON', name: 'Same-day edit film', description: 'A short film played at the reception.', unitPrice: 30000, inDefaultKit: true },
  { key: 'addon-extra-photographer', group: 'addons', kind: 'ADDON', name: 'Extra photographer', description: 'One more photographer for the whole day.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 9000, inDefaultKit: true },
  { key: 'addon-extra-videographer', group: 'addons', kind: 'ADDON', name: 'Extra videographer', description: 'One more videographer for the whole day.', pricingType: 'PER_DAY', unitLabel: 'day', unitPrice: 12000 },
  { key: 'addon-reels', group: 'addons', kind: 'ADDON', name: 'Instagram reels (3)', description: 'Three short vertical videos ready to post.', unitPrice: 8000, inDefaultKit: true },
  { key: 'addon-extra-hours', group: 'addons', kind: 'ADDON', name: 'Extra hour of coverage', description: 'If the function runs longer than planned.', unitPrice: 3000, allowQuantity: true, minQuantity: 1, maxQuantity: 8, unitLabel: 'hour' },
  { key: 'addon-live-stream', group: 'addons', kind: 'ADDON', name: 'Live streaming', description: 'Family who cannot travel can watch live.', unitPrice: 20000 },
  { key: 'addon-teaser', group: 'addons', kind: 'ADDON', name: 'Wedding teaser (30 seconds)', description: 'A quick teaser within 2 days of the event.', unitPrice: 5000 },
  { key: 'addon-framed-photo', group: 'addons', kind: 'ADDON', name: 'Framed photograph', description: 'A large framed print of a favourite photograph.', unitPrice: 3000, allowQuantity: true, minQuantity: 1, maxQuantity: 10, unitLabel: 'frame' },
  { key: 'addon-pendrive', group: 'addons', kind: 'ADDON', name: 'All photographs on a pen drive', description: 'Every edited photograph in a branded pen drive.', unitPrice: 2500 },
];

export const templateByKey = new Map(TEMPLATE_ITEMS.map((t) => [t.key, t]));
export const groupById = new Map(TEMPLATE_GROUPS.map((g) => [g.id, g]));
export const DEFAULT_KIT_KEYS = TEMPLATE_ITEMS.filter((t) => t.inDefaultKit).map((t) => t.key);
