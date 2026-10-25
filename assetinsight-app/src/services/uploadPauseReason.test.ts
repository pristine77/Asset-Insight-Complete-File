/**
 * A pause records why it happened, so an open report can tell the automatic
 * pause on a lost connection from a pause someone asked for (2026-10-02).
 */
import { assertUploadGeneration, createUploadOperation, pauseActiveUploads, setUploadOwner, uploadGeneration } from './uploadCancellation';

function pauseOf(check: () => void): any {
  try { check(); } catch (error) { return error; }
  throw new Error('expected the operation to be paused');
}

beforeEach(() => { setUploadOwner('owner'); });

it('marks an operation stopped by the automatic connection pause', () => {
  const operation = createUploadOperation();
  pauseActiveUploads('connection');
  expect(pauseOf(() => operation.assertActive())).toMatchObject({ code: 'ERR_CANCELED', pauseReason: 'connection' });
});

it('gives no reason for a pause someone asked for', () => {
  const operation = createUploadOperation();
  pauseActiveUploads();
  const error = pauseOf(() => operation.assertActive());
  expect(error.code).toBe('ERR_CANCELED');
  expect(error.pauseReason).toBeUndefined();
});

it('still cancels foreground work when its lifecycle is torn down', () => {
  const operation = createUploadOperation();
  pauseActiveUploads(undefined, 'lifecycle');
  expect(pauseOf(() => operation.assertActive()).code).toBe('ERR_CANCELED');
});

it('takes the reason from the pause that stopped the operation, not a later one', () => {
  const operation = createUploadOperation();
  pauseActiveUploads();
  pauseActiveUploads('connection');
  expect(pauseOf(() => operation.assertActive()).pauseReason).toBeUndefined();
  const later = createUploadOperation();
  pauseActiveUploads('connection');
  expect(pauseOf(() => later.assertActive()).pauseReason).toBe('connection');
});

it('carries the reason through a generation check as well', () => {
  const generation = uploadGeneration();
  pauseActiveUploads('connection');
  expect(pauseOf(() => assertUploadGeneration(generation)).pauseReason).toBe('connection');
});

it('leaves work started after the pause running', () => {
  pauseActiveUploads('connection');
  const operation = createUploadOperation();
  expect(operation.isActive()).toBe(true);
  expect(() => operation.assertActive()).not.toThrow();
});
