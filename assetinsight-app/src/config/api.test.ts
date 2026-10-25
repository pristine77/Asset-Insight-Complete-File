import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_API_BASE_URL, resolveApiBaseUrl } from './api';

describe('public API configuration', () => {
  it.each([undefined, '', '   '])('retains the production default when unset: %s', (value) => {
    expect(resolveApiBaseUrl(value)).toBe('https://api.assetinsightvaluator.com/api');
    expect(resolveApiBaseUrl(value)).toBe(DEFAULT_API_BASE_URL);
  });

  it.each([
    [' https://staging.example.com/api/// ', 'https://staging.example.com/api'],
    ['HTTPS://API.EXAMPLE.COM/v2/', 'https://api.example.com/v2'],
    ['http://10.0.2.2:4000/api', 'http://10.0.2.2:4000/api'],
    ['http://localhost:4000/api/', 'http://localhost:4000/api'],
    ['http://127.0.0.1:4000/api', 'http://127.0.0.1:4000/api'],
    ['http://[::1]:4000/api', 'http://[::1]:4000/api'],
    ['http://192.168.1.20:4000/api', 'http://192.168.1.20:4000/api'],
    ['http://172.16.0.2:4000/api', 'http://172.16.0.2:4000/api'],
    ['http://172.31.1.2:4000/api', 'http://172.31.1.2:4000/api'],
  ])('accepts an explicit public HTTPS or local API base: %s', (value, expected) => {
    expect(resolveApiBaseUrl(value)).toBe(expected);
  });

  it.each([
    'not-a-url',
    '/api',
    '//example.com/api',
    'file:///api',
    'http://example.com/api',
    'http://172.32.0.1/api',
    'http://192.169.1.1/api',
    'http://10.evil.example/api',
    'http://10.0.999.1/api',
    'https://user:password@example.com/api',
    'https://example.com/api?token=secret',
    'https://example.com/api#fragment',
    'https://example.com:70000/api',
    'https://example.com:0/api',
    'https://example..com/api',
    'https://example.com\\evil/api',
    'https://example.com/with space',
  ])('rejects invalid overrides without silently contacting production: %s', (value) => {
    expect(() => resolveApiBaseUrl(value)).toThrow('Invalid EXPO_PUBLIC_API_BASE_URL');
    try {
      resolveApiBaseUrl(value);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('uses the Expo-supported literal public environment reference', () => {
    const source = fs.readFileSync(path.join(__dirname, 'api.ts'), 'utf8');
    expect(source).toContain('resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL)');
  });
});
