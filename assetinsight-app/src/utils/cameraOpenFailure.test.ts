import { CAMERA_NOT_OPENED_TITLE, cameraOpenFailureButtons, describeCameraOpenFailure } from './cameraOpenFailure';

describe('why the camera did not open', () => {
  it('names the save failure and what to do next', () => {
    const message = describeCameraOpenFailure(new Error('Draft media save failed: saved 3 of 4 captured file(s).'));
    expect(CAMERA_NOT_OPENED_TITLE).toBe('Camera not opened');
    expect(message).toContain('could not be saved on the phone first, so the camera did not open');
    expect(message).toContain('Reason: Draft media save failed: saved 3 of 4 captured file(s).');
    expect(message).toContain('Fix the problem, then tap Try again.');
  });

  it('still explains itself when the failure carries no message', () => {
    const message = describeCameraOpenFailure(undefined);
    expect(message).not.toContain('Reason:');
    expect(message).toContain('the camera did not open');
  });

  it('offers Not now and Try again, and only Try again retries', () => {
    const retry = jest.fn();
    const buttons = cameraOpenFailureButtons(retry);
    expect(buttons.map(button => button.text)).toEqual(['Not now', 'Try again']);
    expect(buttons[0]).toMatchObject({ style: 'cancel' });
    expect(buttons[0].onPress).toBeUndefined();
    buttons[1].onPress?.();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
