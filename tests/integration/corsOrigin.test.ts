import { describe, expect, it } from 'vitest';
import { api, base } from '../helpers/api';

/**
 * CORS decides which sites may make credentialed calls with a signed-in user's
 * cookies. In production those cookies are SameSite=None, so a wrongly allowed
 * origin is a real account-takeover path, not a theoretical one.
 */
describe('CORS origin allowlist', () => {
  const originAllowed = async (origin: string) => {
    const response = await api().get(`${base}/health`).set('Origin', origin);
    return response.headers['access-control-allow-origin'] !== undefined;
  };

  it('allows a configured origin', async () => {
    expect(await originAllowed('http://localhost:3000')).toBe(true);
  });

  it('refuses a vercel.app subdomain that merely starts with the project name', async () => {
    // Anyone can register these: *.vercel.app names are first-come-first-served,
    // so a project-name prefix was never proof of ownership.
    expect(await originAllowed('https://frameloom-evil.vercel.app')).toBe(false);
    expect(await originAllowed('https://frameloom-attacker.vercel.app')).toBe(false);
  });

  it('refuses unrelated and look-alike origins', async () => {
    expect(await originAllowed('https://evil.example.com')).toBe(false);
    expect(await originAllowed('https://frameloom.vercel.app.evil.com')).toBe(false);
    expect(await originAllowed('http://localhost:3000.evil.com')).toBe(false);
  });
});
