import { auctioneerErrorMessage, auctioneerReopenErrorMessage, auctioneerReopenReason, auctioneerReopenReasons } from './auctioneerErrors';

const fallback = 'Could not load assigned contracts. Check your connection and retry.';

it('preserves useful provider instructions', () => {
  expect(
    auctioneerErrorMessage(
      {
        response: {
          status: 409,
          data: {
            message: 'This contract is now assigned to another appraiser. Refresh Incoming.',
          },
        },
      },
      fallback
    )
  ).toBe('This contract is now assigned to another appraiser. Refresh Incoming.');
});

it.each(Object.keys(auctioneerReopenReasons))('explains Re-Open refusal %s without exposing its transport code', (code) => {
  const result = auctioneerReopenErrorMessage({ response: { status: 409, data: { code, message: 'Request failed with status code 409' } } });
  expect(result).toBe(auctioneerReopenReasons[code]);
  expect(result).not.toMatch(/409|LOTS_CLOSING_STARTED|EVENT_CLOSED|PROPOSAL_REVIEWED|REVOKED|NO_GRANT|AMBIGUOUS_REOPEN_USER/);
});

it.each(['__proto__', 'constructor', 'toString', 'UNKNOWN_REOPEN_CODE'])('keeps inherited or unknown Re-Open reason %s out of rendered output', (code) => {
  expect(auctioneerReopenReason(code)).toBeUndefined();
  expect(auctioneerReopenErrorMessage({ response: { status: 409, data: { code, message: 'Request failed with status code 409' } } })).toBe(
    'This assignment has changed. Refresh Incoming before continuing. Your saved reports and photos have not been removed.'
  );
});

it.each([
  'http://127.0.0.1:3331/api/tasks',
  'https://private-upstream.example/api/tasks',
  'localhost:3331',
  'Request failed with status code 409',
  'Network Error',
  '<html>502 Bad Gateway</html>',
])('replaces transport diagnostics with recovery instructions: %s', (message) => {
  const result = auctioneerErrorMessage({ response: { status: 409, data: { message } } }, fallback);
  expect(result).toContain('assignment has changed');
  expect(result).not.toMatch(/https?:|localhost|status code|<html>/);
});

it('distinguishes an upstream server failure from the phone connection', () => {
  expect(
    auctioneerErrorMessage(
      { response: { status: 502, data: { message: 'fetch failed' } } },
      fallback
    )
  ).toContain('server could not connect');
  expect(auctioneerErrorMessage(new Error('Network Error'), fallback)).toBe(fallback);
});

it.each([null, undefined, {}, { message: {} }])(
  'handles missing or malformed errors without throwing %#',
  (error) => {
    expect(auctioneerErrorMessage(error, fallback)).toBe(fallback);
  }
);
