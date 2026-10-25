import api from './api';
import crmService from './crmService';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn() } }));
beforeEach(() => jest.clearAllMocks());

it('retains queued Outlook outcomes without inventing an event', async () => {
  jest.mocked(api.post).mockResolvedValue({ status: 202, data: { pending: true, message: 'Queued for Outlook.' } });
  expect(await crmService.addTaskToOutlookCalendar('task')).toEqual({
    pending: true, message: 'Queued for Outlook.', eventId: undefined, webLink: undefined,
  });
});

it('keeps bulk pending outcomes separate from created and failed', async () => {
  const result = { createdCount: 1, failedCount: 1, pendingCount: 1,
    created: [{ taskId: 'done', eventId: 'confirmed' }], failed: [{ taskId: 'bad', reason: 'Bad date' }],
    pending: [{ taskId: 'waiting', reason: 'Queued for Outlook.' }] };
  jest.mocked(api.post).mockResolvedValue({ data: result });
  expect(await crmService.addTasksToOutlookCalendarBulk(['done', 'bad', 'waiting'])).toEqual(result);
});
