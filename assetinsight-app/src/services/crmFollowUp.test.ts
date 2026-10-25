/**
 * Phone helpers for CRM follow-up dates (2026-10-11): what a Task Update sends,
 * when a follow-up counts as passed, and the CRM Calendar's month grid.
 */
import {
  asSentence,
  buildMonthGrid,
  followUpChange,
  followUpReminderSentFor,
  followUpReminderText,
  formatFollowUp,
  groupFollowUpsByDate,
  initialFollowUpDraft,
  isFollowUpPast,
  localDate,
  localDateString,
  localTimeString,
} from './crmFollowUp';
import type { CrmTaskItem } from './crmService';

jest.mock('expo-localization', () => ({ getCalendars: () => [{ timeZone: 'America/Regina' }] }));

// Sunday 2026-10-11, noon on the phone's clock.
const NOW = new Date(2026, 9, 11, 12, 0);
const task = (extra: Partial<CrmTaskItem>) => ({ _id: 't', status: 'contacted', ...extra }) as CrmTaskItem;

describe('dates on the phone', () => {
  it('reads and writes local calendar dates and times', () => {
    expect(localDateString(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
    expect(localTimeString(new Date(2026, 9, 5, 9, 5))).toBe('09:05');
    expect(localDate('2026-10-20', '15:30').getHours()).toBe(15);
    expect(formatFollowUp('2026-10-20', '15:00', NOW)).toMatch(/Oct 20 · 3:00/);
    expect(formatFollowUp('2027-01-04', null, NOW)).toMatch(/2027/);
    expect(followUpReminderText('2026-10-20', null, NOW)).toMatch(/Reminder at 8 a\.m\. that day/);
    expect(followUpReminderText('2026-10-20', '15:00', NOW)).toMatch(/Reminder 1 hour before/);
  });

  it('ends a time like "2:00 p.m." with one period, not two', () => {
    expect(asSentence('Follow-up Tue, Oct 20 · 2:00 p.m.')).toBe('Follow-up Tue, Oct 20 · 2:00 p.m.');
    expect(asSentence('Follow-up Tue, Oct 20 · 2:00 PM')).toBe('Follow-up Tue, Oct 20 · 2:00 PM.');
    expect(followUpReminderText('2026-10-20', '14:00', NOW)).not.toMatch(/\.\./);
    expect(followUpReminderText('2026-10-20', null, NOW)).not.toMatch(/\.\./);
  });

  it('says the reminder comes within minutes once its moment has passed', () => {
    // Today after 8 a.m.: the server's next sweep sends it.
    expect(followUpReminderText('2026-10-11', null, NOW)).toMatch(/Reminder within a few minutes\./);
    expect(followUpReminderText('2026-10-11', null, new Date(2026, 9, 11, 7, 0))).toMatch(/Reminder at 8 a\.m\. that day/);
    // Less than an hour ahead.
    expect(followUpReminderText('2026-10-11', '12:30', NOW)).toMatch(/Reminder within a few minutes\./);
    expect(followUpReminderText('2026-10-11', '13:30', NOW)).toMatch(/Reminder 1 hour before/);
  });

  it('says "Reminder sent" for the saved follow-up once the server has sent it', () => {
    const sent = task({ followUpDate: '2026-10-11', followUpReminderSentAt: '2026-10-11T14:00:00.000Z' });
    expect(followUpReminderSentFor(sent, { date: '2026-10-11', time: null })).toBe(true);
    // A different pick gets a new reminder.
    expect(followUpReminderSentFor(sent, { date: '2026-10-12', time: null })).toBe(false);
    expect(followUpReminderSentFor(sent, { date: '2026-10-11', time: '15:00' })).toBe(false);
    expect(followUpReminderSentFor(task({ followUpDate: '2026-10-11' }), { date: '2026-10-11', time: null })).toBe(false);
    expect(followUpReminderText('2026-10-11', null, NOW, true)).toMatch(/Follow-up .*Oct 11\. Reminder sent\. Automatic/);
  });

  it('asks for a later time when the picked time has passed (the server refuses it)', () => {
    const text = followUpReminderText('2026-10-11', '11:00', NOW);
    expect(text).toMatch(/That time has passed\. Pick a later time or remove the time\./);
    expect(text).not.toMatch(/Automatic reminders/);
  });

  it('a date-only follow-up passes after its day; a timed one after its time', () => {
    expect(isFollowUpPast(task({ followUpDate: '2026-10-11' }), NOW)).toBe(false);
    expect(isFollowUpPast(task({ followUpDate: '2026-10-10' }), NOW)).toBe(true);
    const at = new Date(2026, 9, 11, 11, 0).toISOString();
    expect(isFollowUpPast(task({ followUpDate: '2026-10-11', followUpTime: '11:00', followUpAt: at }), NOW)).toBe(true);
    expect(isFollowUpPast(task({}), NOW)).toBe(false);
  });
});

describe('what Task Update sends', () => {
  const upcoming = task({ followUpDate: '2026-10-20', followUpTime: '15:00', followUpAt: new Date(2026, 9, 20, 15).toISOString() });

  it('starts from the upcoming follow-up, or empty when there is none or it has passed', () => {
    expect(initialFollowUpDraft(upcoming, NOW)).toEqual({ date: '2026-10-20', time: '15:00' });
    expect(initialFollowUpDraft(task({ followUpDate: '2026-10-01' }), NOW)).toEqual({ date: null, time: null });
    expect(initialFollowUpDraft(null, NOW)).toEqual({ date: null, time: null });
  });

  it('sends nothing when unchanged, the new value when changed, and clear when removed', () => {
    expect(followUpChange(upcoming, { date: '2026-10-20', time: '15:00' }, 'contacted', 'America/Regina', NOW)).toBeUndefined();
    expect(followUpChange(upcoming, { date: '2026-10-21', time: null }, 'contacted', 'America/Regina', NOW))
      .toEqual({ date: '2026-10-21', timeZone: 'America/Regina' });
    expect(followUpChange(upcoming, { date: '2026-10-20', time: '09:00' }, 'contacted', 'America/Regina', NOW))
      .toEqual({ date: '2026-10-20', time: '09:00', timeZone: 'America/Regina' });
    expect(followUpChange(upcoming, { date: null, time: null }, 'contacted', 'America/Regina', NOW)).toBe('clear');
    expect(followUpChange(task({}), { date: null, time: null }, 'contacted', 'America/Regina', NOW)).toBeUndefined();
  });

  it('sends nothing for Won or Lost (the server ends the follow-up)', () => {
    expect(followUpChange(upcoming, { date: '2026-10-21', time: null }, 'won', 'America/Regina', NOW)).toBeUndefined();
    expect(followUpChange(upcoming, { date: null, time: null }, 'lost', 'America/Regina', NOW)).toBeUndefined();
  });
});

describe('the CRM Calendar month', () => {
  it('builds six Sunday-first weeks around the month', () => {
    const grid = buildMonthGrid(2026, 9); // October 2026 starts on a Thursday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('2026-09-27');
    expect(grid[4]).toBe('2026-10-01');
    expect(grid[41]).toBe('2026-11-07');
  });

  it('groups follow-ups by day, date-only first, then by time', () => {
    const grouped = groupFollowUpsByDate([
      task({ _id: 'b', followUpDate: '2026-10-20', followUpTime: '15:00' }),
      task({ _id: 'a', followUpDate: '2026-10-20' }),
      task({ _id: 'c', followUpDate: '2026-10-20', followUpTime: '09:30' }),
      task({ _id: 'x' }),
    ]);
    expect(grouped.get('2026-10-20')?.map((item) => item._id)).toEqual(['a', 'c', 'b']);
    expect(grouped.size).toBe(1);
  });
});
