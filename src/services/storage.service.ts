import crypto from 'crypto';
import path from 'path';
import { StorageProvider } from '@prisma/client';
import { env } from '../config/env';

export interface SignedUrl {
  url: string;
  expiresAt: Date;
  provider: StorageProvider;
}

/**
 * Storage abstraction. PostgreSQL only ever holds metadata — the binary lives
 * with the provider (§22), and clients receive short-lived signed URLs rather
 * than a permanent public link.
 *
 * S3, Cloudflare R2 and Supabase Storage are all S3-compatible, so wiring any
 * of them up means implementing `presign` below with the provider SDK; the
 * database shape and every caller stay unchanged.
 */
export function getStorageProvider(): StorageProvider {
  return env.STORAGE_PROVIDER as StorageProvider;
}

/** Deterministic, collision-resistant object key. Never trusts the client name. */
export function buildObjectKey(
  organizationId: string,
  entityType: string,
  originalName: string,
): string {
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${organizationId}/${entityType.toLowerCase()}/${stamp}/${crypto.randomUUID()}-${safeName}`;
}

export function createSignedUrl(objectKey: string, bucket: string): SignedUrl {
  const expiresAt = new Date(Date.now() + env.SIGNED_URL_TTL_SECONDS * 1000);
  const provider = getStorageProvider();

  if (provider === 'LOCAL' || provider === 'DATABASE') {
    // LOCAL and DATABASE both expose a short-lived backend URL. LOCAL reads
    // the development filesystem; DATABASE reads the FileObject bytea column.
    const expires = Math.floor(expiresAt.getTime() / 1000);
    const signature = crypto
      .createHmac('sha256', env.JWT_SECRET)
      .update(`${bucket}/${objectKey}:${expires}`)
      .digest('hex');
    const base = env.STORAGE_PUBLIC_BASE_URL || `http://localhost:${env.PORT}/files`;
    return {
      url: `${base}/${objectKey}?expires=${expires}&signature=${signature}`,
      expiresAt,
      provider,
    };
  }

  // S3, R2 and Supabase Storage are all S3-compatible, so one presigned GET
  // serves them. The bytes never pass through this process.
  return {
    url: presignS3Url({ ...s3Target(objectKey, bucket), method: 'GET', expiresIn: env.SIGNED_URL_TTL_SECONDS }),
    expiresAt,
    provider,
  };
}

// ---------------------------------------------------------------------------
// S3-compatible presigning (AWS Signature Version 4, query-string form)
//
// R2, S3 and Supabase Storage all speak the S3 API, so one implementation
// covers them. Done with `crypto` rather than the AWS SDK: this runs on a
// serverless host where the SDK's size costs cold-start time, and presigning
// is a self-contained calculation with no network call.
// ---------------------------------------------------------------------------

const sha256Hex = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => crypto.createHmac('sha256', key).update(value).digest();

/** Percent-encodes per RFC 3986, which is stricter than encodeURIComponent. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Each path segment is encoded separately so the separators survive. */
const encodePath = (path: string) => path.split('/').map(rfc3986).join('/');

export interface PresignInput {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** Extra query parameters that belong to the request and so must be signed (multipart: uploads, uploadId, partNumber). */
  query?: Record<string, string>;
  host: string;
  /** Already-encoded absolute path, e.g. `/bucket/object%20key.jpg`. */
  canonicalUri: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn: number;
  now?: Date;
  protocol?: string;
}

/** Builds a presigned URL. Exported so the signature can be unit tested. */
export function presignS3Url(input: PresignInput): string {
  const now = input.now ?? new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;

  const query = new Map<string, string>([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
    ...Object.entries(input.query ?? {}),
  ]);
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    canonicalQuery,
    `host:${input.host}\n`,
    'host',
    // The body is not signed: the browser PUTs it straight to the provider.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signature = crypto
    .createHmac(
      'sha256',
      hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), 's3'), 'aws4_request'),
    )
    .update(stringToSign)
    .digest('hex');

  return `${input.protocol ?? 'https:'}//${input.host}${input.canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Resolves the bucket endpoint for the configured S3-compatible provider. */
function s3Target(objectKey: string, bucket: string) {
  const endpoint = env.STORAGE_ENDPOINT?.replace(/\/$/, '');
  if (!endpoint) throw new Error('STORAGE_ENDPOINT is required for S3-compatible storage');
  if (!env.STORAGE_ACCESS_KEY_ID || !env.STORAGE_SECRET_ACCESS_KEY) {
    throw new Error('STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY are required for S3-compatible storage');
  }
  const url = new URL(endpoint);
  return {
    host: url.host,
    protocol: url.protocol,
    // Path-style addressing, which R2 and S3-compatible endpoints all accept.
    canonicalUri: `${encodePath(url.pathname.replace(/\/$/, ''))}/${encodePath(bucket)}/${encodePath(objectKey)}`,
    // R2 has a single region and expects the literal "auto".
    region: env.STORAGE_REGION || 'auto',
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
  };
}

/**
 * A short-lived URL the browser PUTs bytes to. LOCAL and DATABASE reuse the
 * backend's own signed route; the S3-compatible providers get a real presigned
 * PUT so the file never passes through this process.
 */
export function createUploadUrl(objectKey: string, bucket: string): SignedUrl {
  const provider = getStorageProvider();
  const expiresAt = new Date(Date.now() + env.SIGNED_URL_TTL_SECONDS * 1000);
  if (provider === 'LOCAL' || provider === 'DATABASE') return createSignedUrl(objectKey, bucket);
  return {
    url: presignS3Url({ ...s3Target(objectKey, bucket), method: 'PUT', expiresIn: env.SIGNED_URL_TTL_SECONDS }),
    expiresAt,
    provider,
  };
}

/** Validates the short-lived URLs used by the local development storage driver. */
export function verifyLocalSignedUrl(bucket: string, objectKey: string, expiresValue: unknown, signatureValue: unknown): boolean {
  const expires = typeof expiresValue === 'string' ? Number(expiresValue) : NaN;
  const signature = typeof signatureValue === 'string' ? signatureValue : '';
  if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', env.JWT_SECRET).update(`${bucket}/${objectKey}:${expires}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/** Keeps LOCAL uploads inside the backend working directory and prevents path traversal. */
export function localObjectPath(objectKey: string): string | null {
  const root = path.resolve(process.cwd(), '.local-storage');
  const target = path.resolve(root, objectKey);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

// ---------------------------------------------------------------------------
// Multipart uploads (S3-compatible providers only). A film of several gigabytes cannot travel as one PUT,
// so the browser sends it in parts straight to the provider; this process only starts and finishes the upload.
// ---------------------------------------------------------------------------

export const supportsMultipart = () => ['S3', 'R2', 'SUPABASE'].includes(getStorageProvider());

const presignedCall = (method: 'POST' | 'DELETE' | 'PUT', objectKey: string, bucket: string, query: Record<string, string>) =>
  presignS3Url({ ...s3Target(objectKey, bucket), method, query, expiresIn: env.SIGNED_URL_TTL_SECONDS });

async function providerCall(url: string, init: RequestInit): Promise<string> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  // S3 can answer 200 with an <Error> document when completing a multipart upload.
  if (!res.ok || /<Error>/.test(text)) throw new Error(`Storage provider rejected the request (${res.status})`);
  return text;
}

export async function createMultipartUpload(objectKey: string, bucket: string, contentType: string): Promise<string> {
  const xml = await providerCall(presignedCall('POST', objectKey, bucket, { uploads: '' }), { method: 'POST', headers: { 'content-type': contentType } });
  const id = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
  if (!id) throw new Error('Storage provider did not return an upload id');
  return id;
}

export const presignPartUrl = (objectKey: string, bucket: string, uploadId: string, partNumber: number) =>
  presignedCall('PUT', objectKey, bucket, { partNumber: String(partNumber), uploadId });

export async function completeMultipartUpload(objectKey: string, bucket: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
  const body = `<CompleteMultipartUpload>${[...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
  await providerCall(presignedCall('POST', objectKey, bucket, { uploadId }), { method: 'POST', headers: { 'content-type': 'application/xml' }, body });
}

export async function abortMultipartUpload(objectKey: string, bucket: string, uploadId: string) {
  await providerCall(presignedCall('DELETE', objectKey, bucket, { uploadId }), { method: 'DELETE' }).catch(() => undefined);
}
