import crypto from 'crypto';

/** Opaque URL-safe token (256 bits). Only its SHA-256 is ever stored. */
export const newToken = (): string => crypto.randomBytes(32).toString('base64url');
export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
