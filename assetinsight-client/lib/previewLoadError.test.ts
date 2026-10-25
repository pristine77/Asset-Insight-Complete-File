import { expect, it } from 'vitest';
import { previewLoadError } from './previewLoadError';
it.each([
  [{ response: { status: 401 } }, 'Sign in again'],
  [{ response: { status: 403 } }, 'approval'],
  [{ response: { status: 429 } }, 'too many requests'],
  [{ response: { status: 503, data: { message: '<html>stack trace</html>' } } }, 'server could not load'],
  [{ code: 'ECONNABORTED' }, 'timed out'],
  [{ code: 'ERR_NETWORK' }, 'even with an internet connection'],
  [{ response: { status: 409, data: { message: 'This report has moved to another account.' } } }, 'moved to another account'],
  [{ message: 'Request failed with status code 409' }, 'could not be read'],
])('explains a read failure without raw status codes', (error, message) => {
  expect(previewLoadError(error)).toContain(message);
  expect(previewLoadError(error)).not.toMatch(/status code|stack trace|<html>/);
});
