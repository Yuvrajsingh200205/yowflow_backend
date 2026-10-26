import { z } from 'zod';
import { dateOnly, isoDateTime, listQuery, nonNegativeDecimal, uuid } from './common.validator';

export const PROJECT_STATUS = z.enum([
  'UPCOMING',
  'LEAD',
  'CONFIRMED',
  'PLANNING',
  'SHOOTING',
  'EDITING',
  'DELIVERY',
  'COMPLETED',
  'CANCELLED',
]);

export const PROJECT_TYPE = z.enum([
  'ROKA',
  'ENGAGEMENT',
  'PRE_WEDDING',
  'WEDDING',
  'COMPLETE_WEDDING_SERVICES',
  'HALDI_MEHENDI',
  'SANGEET',
  'RECEPTION',
  'ANNIVERSARY',
  'CORPORATE',
  'OTHER',
]);

const toDate = dateOnly.transform((v) => new Date(`${v}T00:00:00Z`));

const embeddedProjectClientSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  primaryPhone: z.string().regex(/^[6-9][0-9]{9}$/, 'Must be a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9'),
  primaryEmail: z.string().email().max(160).toLowerCase().optional(),
});

const embeddedProjectTaskStatus = z.enum([
  'TODO',
  'ASSIGNED',
  'IN_PROGRESS',
  'PAUSED',
  'IN_REVIEW',
  'COMPLETED',
  'CANCELLED',
]);

const embeddedProjectTaskPriority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

const embeddedProjectTaskCategory = z.enum([
  'PHOTO_EDITING',
  'VIDEO_EDITING',
  'CULLING',
  'COLOR_GRADING',
  'ALBUM_DESIGN',
  'ALBUM_PRINTING',
  'SHOOT_COVERAGE',
  'DATA_BACKUP',
  'CLIENT_MEETING',
  'DELIVERY',
  'ADMIN',
  'OTHER',
]);

const embeddedProjectShootStatus = z.enum([
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'POSTPONED',
]);

const embeddedProjectShootType = z.enum([
  'PHOTO',
  'VIDEO',
  'PHOTO_AND_VIDEO',
  'DRONE',
  'CANDID',
  'TRADITIONAL',
  'PRE_WEDDING',
  'OTHER',
]);

const embeddedProjectCrewRole = z.enum([
  'LEAD_PHOTOGRAPHER',
  'CANDID_PHOTOGRAPHER',
  'TRADITIONAL_PHOTOGRAPHER',
  'CINEMATOGRAPHER',
  'TRADITIONAL_VIDEOGRAPHER',
  'DRONE_OPERATOR',
  'ASSISTANT',
  'LIGHT_ASSISTANT',
  'LIVE_EDITOR',
  'COORDINATOR',
  'OTHER',
]);

export const projectListQuery = listQuery.extend({
  status: PROJECT_STATUS.optional(),
  isUrgent: z.coerce.boolean().optional(),
  type: PROJECT_TYPE.optional(),
  clientId: uuid.optional(),
  managerId: uuid.optional(),
  branchId: uuid.optional(),
});

const embeddedEventSchema = z.object({
  name: z.string().trim().min(1).max(160),
  eventTypeId: uuid.optional(),
  eventDate: toDate,
  startTime: isoDateTime.optional(),
  endTime: isoDateTime.optional(),
  venueName: z.string().max(200).optional(),
  address: z.string().max(255).optional(),
  city: z.string().max(80).optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * A planned slot is either one named crew row (requiredCount 1) or a headcount
 * for a role nobody is assigned to yet (e.g. 2 photographers, no names).
 */
const plannedRoleSlotSchema = z.object({
  role: z.string().trim().min(1).max(80),
  requiredCount: z.coerce.number().int().min(1).max(100),
  name: z.string().trim().max(160).optional(),
  mobile: z.string().trim().max(30).optional(),
  dataReceived: z.boolean().optional(),
  dataSizeGb: nonNegativeDecimal.optional(),
  copyInHD: z.string().max(160).optional(),
  backupInHD: z.string().max(2000).optional(),
});

const embeddedProjectShootSchema = z.object({
  title: z.string().trim().min(1).max(160),
  shootType: embeddedProjectShootType.optional(),
  shootDate: toDate,
  startTime: isoDateTime.optional(),
  endTime: isoDateTime.optional(),
  location: z.string().max(255).optional(),
  city: z.string().max(80).optional(),
  notes: z.string().max(5000).optional(),
  status: embeddedProjectShootStatus.optional(),
  plannedRoleSlots: z.array(plannedRoleSlotSchema).max(30).optional(),
  crewAssignments: z.array(z.object({
    userId: uuid,
    role: embeddedProjectCrewRole,
  })).max(30).optional(),
});

/** An advance taken when the booking is made. It is saved in the same step as the project, so a failure leaves neither behind. */
const advancePaymentSchema = z.object({
  amount: z.coerce.number().positive('Enter an amount above zero').max(100_000_000),
  paymentDate: dateOnly,
  paymentMethod: z.enum(['CASH', 'UPI', 'BANK_TRANSFER', 'CREDIT_CARD', 'DEBIT_CARD', 'CHEQUE', 'OTHER']).optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict();

const projectInputSchema = z.object({
  clientId: uuid.optional(),
  client: embeddedProjectClientSchema.optional(),
  leadId: uuid.optional(),
  branchId: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  type: PROJECT_TYPE.optional(),
  status: PROJECT_STATUS.optional(),
  isUrgent: z.boolean().optional(),
  weddingDate: toDate.optional(),
  deliveryDueDate: toDate.optional(),
  venueName: z.string().max(200).optional(),
  venueAddress: z.string().max(255).optional(),
  venueCity: z.string().max(80).optional(),
  totalQuotation: nonNegativeDecimal.optional(),
  totalStorageCapacityGb: z.coerce.number().min(0).optional(),
  customServiceType: z.string().trim().min(1).max(160).optional(),
  otherClientDetails: z.string().trim().max(5000).optional(),
  notes: z.string().max(5000).optional(),
  managerId: uuid.optional(),
  events: z.array(embeddedEventSchema).max(30).optional(),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(5000).optional(),
        category: embeddedProjectTaskCategory.optional(),
        priority: embeddedProjectTaskPriority.optional(),
        quantity: z.coerce.number().int().min(1).max(100000).optional(),
        unit: z.string().max(160).optional(),
        dueDate: toDate.optional(),
        assigneeId: uuid.optional(),
        status: embeddedProjectTaskStatus.optional(),
      }),
    )
    .max(50)
    .optional(),
  shoots: z.array(embeddedProjectShootSchema).max(30).optional(),
  advancePayment: advancePaymentSchema.optional(),
});

/** A custom label is required whenever the generic OTHER project type is used. */
const requireCustomServiceForOther = (
  value: { type?: z.infer<typeof PROJECT_TYPE>; customServiceType?: string },
  ctx: z.RefinementCtx,
) => {
  if (value.type === 'OTHER' && !value.customServiceType?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customServiceType'],
      message: 'Custom service type is required when project type is OTHER.',
    });
  }
};

const requireClientReference = (
  value: { clientId?: string; client?: z.infer<typeof embeddedProjectClientSchema> },
  ctx: z.RefinementCtx,
) => {
  if (!value.clientId && !value.client) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['clientId'],
      message: 'Provide either clientId or client details.',
    });
  }
  if (value.clientId && value.client) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['client'],
      message: 'Provide either clientId or client details, not both.',
    });
  }
};

export const createProjectSchema = projectInputSchema.superRefine((value, ctx) => {
  requireClientReference(value, ctx);
  requireCustomServiceForOther(value, ctx);
});

export const updateProjectSchema = projectInputSchema
  .partial()
  .omit({ clientId: true, client: true, events: true, leadId: true, tasks: true, shoots: true, status: true, advancePayment: true })
  .superRefine(requireCustomServiceForOther);

export const projectStatusSchema = z.object({
  status: PROJECT_STATUS,
  reason: z.string().max(500).optional(),
});

export const projectClientAssetParams = z.object({ id: uuid, assetId: uuid });
export const projectClientAssetUploadIntentSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
});
export const createProjectClientAssetSchema = projectClientAssetUploadIntentSchema.extend({
  bucket: z.string().trim().min(1).max(120), objectKey: z.string().trim().min(1).max(512), sizeBytes: z.coerce.number().int().min(1).max(10 * 1024 * 1024),
  category: z.string().trim().max(80).optional(), title: z.string().trim().max(255).optional(), notes: z.string().max(2000).optional(),
});
export const updateProjectClientAssetSchema = z.object({ category: z.string().trim().max(80).optional(), title: z.string().trim().max(255).optional(), notes: z.string().max(2000).optional() });

// --- Gallery media ----------------------------------------------------------
// Wedding deliveries are photographs and films, so the accepted types and the
// size ceiling are both wider than the client-document vault's.
export const galleryMediaParams = z.object({ id: uuid, mediaId: uuid });
export const galleryUploadIntentSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4', 'video/quicktime', 'video/webm']),
});
export const galleryMultipartInitSchema = galleryUploadIntentSchema.extend({ sizeBytes: z.coerce.number().int().min(1).max(5 * 1024 * 1024 * 1024) });
export const galleryMultipartCompleteSchema = z.object({
  objectKey: z.string().trim().min(1).max(512),
  uploadId: z.string().trim().min(1).max(1024),
  parts: z.array(z.object({ partNumber: z.coerce.number().int().min(1).max(10000), etag: z.string().min(1).max(200) })).min(1).max(10000),
});
export const galleryMultipartAbortSchema = z.object({ objectKey: z.string().trim().min(1).max(512), uploadId: z.string().trim().min(1).max(1024) });
export const shareLinkParams = z.object({ id: uuid, linkId: uuid });
export const createShareLinkSchema = z.object({
  title: z.string().trim().min(1).max(200),
  accessType: z.enum(['VIEW_ONLY', 'VIEW_DOWNLOAD', 'SELECTED_ONLY', 'SECTION_ONLY', 'FULL_GALLERY']),
  sectionId: uuid.optional(),
  mediaIds: z.array(uuid).max(500).optional(),
  // A share password is a convenience for the couple, not an account, so it is
  // held to a length rather than the staff password policy.
  password: z.string().min(4).max(128).optional(),
  expiresAt: z.string().datetime().optional(),
  watermarkEnabled: z.boolean().optional(),
});
export const sharedGalleryQuery = z.object({ password: z.string().max(128).optional() });

export const addGalleryMediaSchema = galleryUploadIntentSchema.extend({
  bucket: z.string().trim().min(1).max(120),
  objectKey: z.string().trim().min(1).max(512),
  sizeBytes: z.coerce.number().int().min(1).max(5 * 1024 * 1024 * 1024),
  title: z.string().trim().max(255).optional(),
  sectionName: z.string().trim().max(160).optional(),
});

// --- Events ---------------------------------------------------------------

export const EVENT_STATUS = z.enum(['PLANNED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);

export const eventListQuery = listQuery.extend({
  projectId: uuid.optional(),
  status: EVENT_STATUS.optional(),
  eventTypeId: uuid.optional(),
});

export const createEventSchema = embeddedEventSchema.extend({
  projectId: uuid,
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  guestCount: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const updateEventSchema = createEventSchema
  .partial()
  .omit({ projectId: true })
  .extend({ status: EVENT_STATUS.optional() });

export const eventTypeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});

// --- Shoots ---------------------------------------------------------------

export const SHOOT_STATUS = z.enum([
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'POSTPONED',
]);

export const SHOOT_TYPE = z.enum([
  'PHOTO',
  'VIDEO',
  'PHOTO_AND_VIDEO',
  'DRONE',
  'CANDID',
  'TRADITIONAL',
  'PRE_WEDDING',
  'OTHER',
]);

export const CREW_ROLE = z.enum([
  'LEAD_PHOTOGRAPHER',
  'CANDID_PHOTOGRAPHER',
  'TRADITIONAL_PHOTOGRAPHER',
  'CINEMATOGRAPHER',
  'TRADITIONAL_VIDEOGRAPHER',
  'DRONE_OPERATOR',
  'ASSISTANT',
  'LIGHT_ASSISTANT',
  'LIVE_EDITOR',
  'COORDINATOR',
  'OTHER',
]);

export const ASSIGNMENT_STATUS = z.enum([
  'PROPOSED',
  'ASSIGNED',
  'CONFIRMED',
  'DECLINED',
  'ON_SHOOT',
  'COMPLETED',
  'CANCELLED',
]);

export const shootListQuery = listQuery.extend({
  projectId: uuid.optional(),
  eventId: uuid.optional(),
  status: SHOOT_STATUS.optional(),
  shootType: SHOOT_TYPE.optional(),
  userId: uuid.optional(),
  freelancerId: uuid.optional(),
});

export const createShootSchema = z.object({
  projectId: uuid,
  eventId: uuid.optional(),
  title: z.string().trim().min(1).max(160),
  shootType: SHOOT_TYPE.optional(),
  shootDate: toDate,
  startTime: isoDateTime.optional(),
  endTime: isoDateTime.optional(),
  location: z.string().max(255).optional(),
  city: z.string().max(80).optional(),
  notes: z.string().max(5000).optional(),
  plannedRoleSlots: z.array(plannedRoleSlotSchema).max(30).optional(),
});

export const updateShootSchema = createShootSchema
  .partial()
  .omit({ projectId: true })
  .extend({
    status: SHOOT_STATUS.optional(),
    dataSizeGb: nonNegativeDecimal.optional(),
    dataReceivedAt: isoDateTime.optional(),
    backupDoneAt: isoDateTime.optional(),
  });

/**
 * Exactly one of userId / freelancerId — the same rule the database enforces
 * with `num_nonnulls(user_id, freelancer_id) = 1`.
 */
export const assignCrewSchema = z
  .object({
    userId: uuid.optional(),
    freelancerId: uuid.optional(),
    role: CREW_ROLE,
    agreedAmount: nonNegativeDecimal.optional(),
    travelAmount: nonNegativeDecimal.optional(),
    extraAmount: nonNegativeDecimal.optional(),
    callTime: isoDateTime.optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => Number(Boolean(v.userId)) + Number(Boolean(v.freelancerId)) === 1, {
    message: 'Provide exactly one of userId or freelancerId',
    path: ['userId'],
  });

export const updateAssignmentSchema = z.object({
  role: CREW_ROLE.optional(),
  status: ASSIGNMENT_STATUS.optional(),
  agreedAmount: nonNegativeDecimal.optional(),
  travelAmount: nonNegativeDecimal.optional(),
  extraAmount: nonNegativeDecimal.optional(),
  checkInAt: isoDateTime.optional(),
  checkOutAt: isoDateTime.optional(),
  dataSizeGb: nonNegativeDecimal.optional(),
  dataReceived: z.boolean().optional(),
  storageReference: z.string().max(160).optional(),
  notes: z.string().max(2000).optional(),
});

export const assignmentParams = z.object({ id: uuid, assignmentId: uuid });
export const paymentMilestoneParams = z.object({ id: uuid, milestoneId: z.string().trim().min(1).max(64) });

const paymentMilestoneStatus = z.enum(['PENDING', 'RECEIVED', 'OVERDUE']);

export const createPaymentMilestoneSchema = z.object({
  title: z.string().trim().min(1).max(160),
  amount: nonNegativeDecimal,
  // The UI sends this calculated value so the submitted form is complete.
  // Amount remains the stored source of truth for the milestone.
  percentage: nonNegativeDecimal.optional(),
  dueDate: toDate,
  status: paymentMilestoneStatus,
  notes: z.string().trim().max(2000).optional(),
});

export const updatePaymentMilestoneSchema = createPaymentMilestoneSchema;
