import { getSubmissionError, isNetworkTransportError } from './connectivityService';

it.each(['NetworkError', 'NetworkError when attempting to fetch resource.', 'Network Error'])('recognizes and explains %s without raw transport text', message => {
  const error = new Error(message);
  expect(isNetworkTransportError(error)).toBe(true);
  const feedback = getSubmissionError(error);
  expect(feedback.title).toBe('Upload Interrupted');
  expect(feedback.message).toContain('Resume upload');
  expect(feedback.message).not.toContain(message);
});

it.each([409, 413, 429, 500, 503])('does not show raw HTTP %s text or HTML', status => {
  for (const data of [undefined, '<html><body>upstream failed</body></html>', { message: `Request failed with status code ${status}` }]) {
    const feedback = getSubmissionError({ response: { status, data }, message: `Request failed with status code ${status}` });
    expect(feedback.message).not.toMatch(/status code|<html>|\b(?:409|413|429|500|503)\b/i);
    expect(feedback.message.length).toBeGreaterThan(30);
  }
});

it('retains actionable validation text from the server', () => {
  expect(getSubmissionError({ response: { status: 400, data: { message: 'Lot 3 needs at least one photo.' } } }).message).toBe('Lot 3 needs at least one photo.');
});

it('retains an actual lot number that happens to equal an HTTP status', () => {
  const message = 'Lot number 409 is already assigned within this event.';
  expect(getSubmissionError({ response: { status: 409, data: { message } } }).message).toBe(message);
});

it.each(['409', 'Request failed with status code 409', 'The photo upload failed for photo.jpg (403).'])('hides transport diagnostics without hiding legitimate numbered lots: %s', message => {
  const feedback = getSubmissionError({ response: { status: 409, data: { message } } });
  expect(feedback.message).not.toBe(message);
  expect(feedback.message).not.toMatch(/\b(?:403|409)\b/);
});

it('does not claim unsaved work was saved on an arbitrary failure', () => {
  expect(getSubmissionError(new Error('Storage full')).message).not.toMatch(/remains saved|are saved/);
});

// 2026-10-11 phone test: a report saved with no connection read "Submission
// Failed", which alarmed staff although nothing had failed.
it('titles a Submit that found no connection as saved, not failed', () => {
  const saved = getSubmissionError(Object.assign(new Error('Saved on this device. Connect and tap Resume upload.'), { code: 'UPLOAD_WAITING_FOR_CONNECTION' }));
  expect(saved).toEqual({ title: 'Saved on this device', message: 'Saved on this device. Connect and tap Resume upload.' });
  expect(getSubmissionError({ code: 'UPLOAD_WAITING_FOR_CONNECTION' }).message).toBe('Your report is saved on this device. Connect, then tap Resume upload.');
  expect(getSubmissionError(new Error('Storage full')).title).toBe('Submission Failed');
});
