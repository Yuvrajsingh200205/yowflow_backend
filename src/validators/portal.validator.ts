import { z } from 'zod';
import { email, password, uuid } from './common.validator';

export const portalLoginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const portalRefreshSchema = z.object({ refreshToken: z.string().min(1).optional() });
export const portalTokenParam = z.object({ token: z.string().min(20).max(200) });
export const portalAcceptInviteSchema = z.object({ password });
export const portalForgotSchema = z.object({ email });
export const portalResetSchema = z.object({ token: z.string().min(20).max(200), password });

export const invitePortalUserSchema = z.object({
  email,
  fullName: z.string().trim().min(2, 'Enter their name').max(160),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
});
export const portalUserParams = z.object({ id: uuid, portalUserId: uuid });
export const portalUserStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });
