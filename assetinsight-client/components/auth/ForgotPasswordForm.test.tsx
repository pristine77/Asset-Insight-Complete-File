import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ForgotPasswordForm from './ForgotPasswordForm';

const mocks = vi.hoisted(() => ({ forgot: vi.fn(), reset: vi.fn(), accept: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ acceptAuthResponse: mocks.accept }) }));
vi.mock('@/components/providers/ColorModeProvider', () => ({ useColorMode: () => ({ mode: 'light', toggleMode: vi.fn() }) }));
vi.mock('@/services/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/auth')>(),
  AuthService: { forgotPassword: mocks.forgot, resetPasswordByCode: mocks.reset },
}));

const requestCode = () => {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'test@example.invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send reset code' }));
};

describe('password recovery request receipts', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not announce a sent code or advance after a network failure', async () => {
    mocks.forgot.mockRejectedValue(new Error('Network Error'));
    render(<ForgotPasswordForm />); requestCode();
    expect(await screen.findByText('We could not confirm the reset-code request. Check your connection and try again.')).toBeVisible();
    expect(screen.queryByLabelText('Reset code')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveValue('test@example.invalid');
    expect(mocks.forgot).toHaveBeenCalledTimes(1);
  });

  it('shows rate-limit guidance instead of claiming email delivery', async () => {
    mocks.forgot.mockRejectedValue({ response: { status: 429, data: { message: 'Wait before requesting another code.' } } });
    render(<ForgotPasswordForm />); requestCode();
    expect(await screen.findByText('Wait before requesting another code.')).toBeVisible();
    expect(screen.queryByLabelText('Reset code')).not.toBeInTheDocument();
  });

  it('retains entered reset data and reports an uncertain resend accurately', async () => {
    mocks.forgot.mockResolvedValueOnce({ message: 'If an account exists, a reset code has been sent.' }).mockRejectedValueOnce(new Error('Network Error'));
    render(<ForgotPasswordForm />); requestCode();
    fireEvent.change(await screen.findByLabelText('Reset code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'fixture-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resend reset code' }));
    expect(await screen.findByText('We could not confirm a new reset code was sent. Check your email before trying again.')).toBeVisible();
    expect(screen.getByLabelText('Reset code')).toHaveValue('123456');
    expect(screen.getByLabelText('New password')).toHaveValue('fixture-password');
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('locks duplicate requests before the loading render', async () => {
    let resolve!: (value: { message: string }) => void;
    mocks.forgot.mockReturnValue(new Promise<{ message: string }>((yes) => { resolve = yes; }));
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'test@example.invalid' } });
    const form = screen.getByRole('button', { name: 'Send reset code' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(mocks.forgot).toHaveBeenCalledTimes(1);
    resolve({ message: 'If an account exists, a reset code has been sent.' });
    await screen.findByLabelText('Reset code');
  });

  it('rejects incomplete codes before consuming a reset attempt', async () => {
    mocks.forgot.mockResolvedValueOnce({ message: 'If an account exists, a reset code has been sent.' });
    render(<ForgotPasswordForm />); requestCode();
    fireEvent.change(await screen.findByLabelText('Reset code'), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'fixture-password' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'fixture-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    await waitFor(() => expect(screen.getByText('Enter the six-digit reset code sent to your email.')).toBeVisible());
    expect(mocks.reset).not.toHaveBeenCalled();
  });
});
