import { describe, expect, it } from 'vitest';
import { presignS3Url } from '../../src/services/storage.service';

/**
 * AWS publishes a worked example for query-string presigning. Matching it byte
 * for byte is what proves the canonical request, the scope and the signing key
 * chain are right — a presigned URL that is subtly wrong fails only against the
 * live provider, which no test here could catch.
 */
describe('presignS3Url', () => {
  const vector = {
    method: 'GET' as const,
    host: 'examplebucket.s3.amazonaws.com',
    canonicalUri: '/test.txt',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresIn: 86400,
    now: new Date('2013-05-24T00:00:00Z'),
  };

  it("matches AWS's published presigned-URL example", () => {
    const url = presignS3Url(vector);

    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Date=20130524T000000Z');
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
    expect(url).toContain('X-Amz-SignedHeaders=host');
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('signs a PUT differently from a GET for the same object', () => {
    const get = presignS3Url(vector);
    const put = presignS3Url({ ...vector, method: 'PUT' });

    expect(put).not.toBe(get);
  });

  it('encodes awkward object keys without breaking the path separators', () => {
    const url = presignS3Url({
      ...vector,
      canonicalUri: '/bucket/org/gallery_media/a%20photo%20%28final%29.jpg',
    });

    expect(url).toContain('/bucket/org/gallery_media/a%20photo%20%28final%29.jpg?');
  });
});
