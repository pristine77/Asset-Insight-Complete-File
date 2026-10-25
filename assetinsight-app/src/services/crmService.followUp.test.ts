/**
 * The Task Update form fields for a follow-up date (2026-10-11) and the
 * follow-up calendar read.
 */
import api from './api';
import crmService from './crmService';

jest.mock('./api', () => ({ __esModule: true, default: { patch: jest.fn(), get: jest.fn() } }));

// The form's text fields, whether the test runs on Node's FormData or React Native's.
const sentParts = () => {
  const form = jest.mocked(api.patch).mock.calls[0][1] as any;
  if (typeof form.entries === 'function') return Object.fromEntries([...form.entries()]);
  return Object.fromEntries((form.getParts?.() ?? form._parts).map((part: any) =>
    Array.isArray(part) ? part : [part.fieldName, part.string]));
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(api.patch).mockResolvedValue({ data: { item: { _id: 'task-1' } } });
});

it('sends a follow-up date, time and zone as form fields', async () => {
  await crmService.submitTaskUpdate('task-1', {
    comment: 'Visit booked', status: 'contacted',
    followUp: { date: '2026-10-20', time: '15:00', timeZone: 'America/Regina' },
  });
  expect(sentParts()).toMatchObject({
    comment: 'Visit booked', status: 'contacted',
    followUpDate: '2026-10-20', followUpTime: '15:00', followUpTimeZone: 'America/Regina',
  });
});

it('sends clearFollowUp to remove it, and nothing when unchanged', async () => {
  await crmService.submitTaskUpdate('task-1', { status: 'contacted', followUp: 'clear' });
  expect(sentParts()).toMatchObject({ clearFollowUp: 'true' });
  expect(sentParts()).not.toHaveProperty('followUpDate');

  jest.mocked(api.patch).mockClear();
  await crmService.submitTaskUpdate('task-1', { status: 'contacted' });
  expect(Object.keys(sentParts())).toEqual(['status']);
});

it('reads the follow-up calendar for a range in the phone zone', async () => {
  jest.mocked(api.get).mockResolvedValue({ data: { items: [{ _id: 'a' }], overdue: [], timeZone: 'America/Regina' } });
  const calendar = await crmService.getFollowUps({ from: '2026-09-27', to: '2026-11-07', timeZone: 'America/Regina' });
  expect(api.get).toHaveBeenCalledWith('/crm/tasks/follow-ups?from=2026-09-27&to=2026-11-07&timeZone=America%2FRegina');
  expect(calendar.items).toHaveLength(1);
  expect(calendar.overdue).toEqual([]);
});
