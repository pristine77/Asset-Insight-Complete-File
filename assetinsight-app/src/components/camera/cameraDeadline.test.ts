import { cameraDeadline, CameraDeadlineError } from './cameraDeadline';

afterEach(() => jest.useRealTimers());
it('bounds an unresolved local-save operation and ignores its eventual completion', async () => {
  jest.useFakeTimers();
  let finish!: (value: string) => void;
  const deadline = cameraDeadline(new Promise<string>(resolve => { finish = resolve; }), 20_000);
  const rejected = expect(deadline).rejects.toBeInstanceOf(CameraDeadlineError);
  await jest.advanceTimersByTimeAsync(20_000); await rejected;
  finish('late snapshot'); await Promise.resolve();
  expect(jest.getTimerCount()).toBe(0);
});
it('clears the deadline after successful preparation', async () => {
  jest.useFakeTimers();
  await expect(cameraDeadline(Promise.resolve('saved'), 20_000)).resolves.toBe('saved');
  expect(jest.getTimerCount()).toBe(0);
});
