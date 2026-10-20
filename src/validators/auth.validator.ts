import { z } from 'zod';
import { email, password } from './common.validator';

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(128),
  organizationSlug: z.string().max(80).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: password,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must differ from the current password',
    path: ['newPassword'],
  });

export const signupSchema = z.object({
  studioName: z.string().trim().min(2, 'Enter your studio name').max(120),
  fullName: z.string().trim().min(2, 'Enter your name').max(120),
  email,
  password,
  plan: z.enum(['starter', 'studio', 'scale']).optional(),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password,
});

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

export const contactSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(120),
  email,
  company: z.string().trim().max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
  message: z.string().trim().min(10, 'Tell us a little more (at least 10 characters)').max(4000),
  source: z.string().trim().max(60).optional(),
  website: z.string().max(200).optional(),
});
