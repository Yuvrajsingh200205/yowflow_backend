import { z } from 'zod';
import { dateOnly, email, nonNegativeDecimal, password, phone, uuid, isoDateTime, listQuery } from './common.validator';
import { CREW_ROLE } from './project.validator';
import { FREELANCER_AVAILABILITY_STATUS, RATE_TYPE, TASK_STATUS } from './ops.validator';

export const freelancerPortalLoginSchema = z.object({
  identifier: z.string().trim().min(1).max(160),
  password: z.string().min(1).max(255),
  studio: z.string().trim().toLowerCase().max(80).optional(),
});

export const freelancerPortalRefreshSchema = z.object({});

const publicFreelancerPassword = z.string().min(6, 'Password must be at least 6 characters').max(128);

export const publicFreelancerApplicationSchema = z.object({
  studio: z.string().trim().toLowerCase().min(2).max(80).optional(),
  fullName: z.string().trim().min(1).max(160),
  phone,
  password: publicFreelancerPassword,
  confirmPassword: z.string().optional(),
  email: email.optional(),
  city: z.string().trim().max(80).optional(),
  primarySkill: CREW_ROLE.optional(),
  skills: z.array(z.string().trim().max(60)).max(30).optional(),
  experienceYears: z.coerce.number().int().min(0).max(70).optional(),
  portfolioUrl: z.string().url().max(1024).optional(),
  expectedRate: nonNegativeDecimal.optional(),
  notes: z.string().max(5000).optional(),
}).refine((v) => v.confirmPassword === undefined || v.confirmPassword === v.password, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

export const freelancerProfileUpdateSchema = z.object({
  fullName: z.string().trim().min(1).max(160).optional(),
  whatsapp: phone.optional().nullable(),
  email: email.optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  addressLine: z.string().max(255).optional().nullable(),
  primarySkill: CREW_ROLE.optional(),
  skills: z.array(z.string().trim().max(60)).max(30).optional(),
  experienceYears: z.coerce.number().int().min(0).max(70).optional().nullable(),
  rate: nonNegativeDecimal.optional(),
  rateType: RATE_TYPE.optional(),
  travelAvailable: z.boolean().optional(),
  maxShootsPerDay: z.coerce.number().int().min(1).max(5).optional(),
  equipmentNotes: z.string().max(5000).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
}).refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const setFreelancerPasswordSchema = z.object({
  password,
});

export const onboardingTokenParam = z.object({
  token: z.string().trim().min(32).max(512),
});

export const onboardingPasswordSchema = z.object({
  password,
  confirmPassword: z.string().optional(),
}).refine((v) => v.confirmPassword === undefined || v.confirmPassword === v.password, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

const portalAvailabilityBaseSchema = z.object({
  date: dateOnly,
  status: FREELANCER_AVAILABILITY_STATUS,
  startTime: isoDateTime.optional().nullable(),
  endTime: isoDateTime.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export const portalAvailabilitySchema = portalAvailabilityBaseSchema.refine((v) => !v.startTime || !v.endTime || v.endTime >= v.startTime, {
  message: 'endTime cannot be before startTime',
  path: ['endTime'],
});

export const portalAvailabilityUpdateSchema = portalAvailabilityBaseSchema
  .omit({ date: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required')
  .refine((v) => !v.startTime || !v.endTime || v.endTime >= v.startTime, {
    message: 'endTime cannot be before startTime',
    path: ['endTime'],
  });

export const portalAvailabilityQuery = listQuery.extend({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  status: FREELANCER_AVAILABILITY_STATUS.optional(),
});

export const portalAvailabilityDateParam = z.object({
  date: dateOnly,
});

export const portalPortfolioCreateSchema = z.object({
  fileObjectId: uuid,
  title: z.string().trim().min(1).max(160),
  description: z.string().max(5000).optional(),
  category: z.string().trim().max(80).optional(),
  sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
  isPublished: z.boolean().optional(),
});

export const portalPortfolioUpdateSchema = portalPortfolioCreateSchema
  .partial()
  .omit({ fileObjectId: true });

export const itemIdParam = z.object({ itemId: uuid });

export const portalResourceIdParam = z.object({ id: uuid });

export const portalProjectListQuery = listQuery.extend({
  status: z.enum(['LEAD', 'UPCOMING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ARCHIVED']).optional(),
});

export const portalShootListQuery = listQuery.extend({
  view: z.enum(['upcoming', 'today', 'completed', 'all']).default('upcoming'),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

export const portalTaskListQuery = listQuery.extend({
  status: TASK_STATUS.optional(),
});

export const portalPaymentListQuery = listQuery;

export const portalNotificationListQuery = listQuery.extend({
  unreadOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const portalTaskStatusUpdateSchema = z.object({
  status: TASK_STATUS,
});

export const portalConnectionResponseSchema = z.object({
  status: z.enum(['ACCEPTED', 'DECLINED']),
  notes: z.string().max(5000).optional().nullable(),
});

export const portalCheckoutSchema = z.object({ planId: z.string().uuid() });
export const portalCheckoutVerifySchema = z.object({ orderId: z.string().min(5).max(80), paymentId: z.string().min(5).max(80), signature: z.string().min(10).max(200) });
export const joinStudioParam = z.object({ slug: z.string().trim().toLowerCase().min(2).max(80) });

export const portalPortfolioIntentSchema = z.object({ originalName: z.string().trim().min(1).max(200), mimeType: z.string().trim().min(3).max(100) });
export const portalPortfolioUploadSchema = z.object({
  bucket: z.string().trim().min(1).max(120),
  objectKey: z.string().trim().min(1).max(500),
  originalName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(3).max(100),
  sizeBytes: z.coerce.number().int().min(1),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(5000).optional(),
  category: z.string().trim().max(80).optional(),
  isPublished: z.boolean().optional(),
});
