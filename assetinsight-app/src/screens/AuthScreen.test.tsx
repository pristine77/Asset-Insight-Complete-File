import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import AuthScreen from './AuthScreen';
import { useAuth } from '../context/AuthContext';
import authService from '../services/authService';

jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../services/authService', () => ({ __esModule: true, default: {
  signup: jest.fn(), verifyEmail: jest.fn(), resendVerificationCode: jest.fn(),
  forgotPassword: jest.fn(), resetPassword: jest.fn(), resetPasswordByCode: jest.fn(),
} }));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({
  isDark: false, colors: new Proxy({}, { get: () => '#222222' }), toggleTheme: jest.fn(),
}) }));

const login = jest.fn(); const refreshUser = jest.fn(); const clearError = jest.fn();
const fill = async (label: string, value: string) => fireEvent.changeText(screen.getByLabelText(label), value);
const press = async (text: string) => fireEvent.press(screen.getByText(text));

beforeEach(() => {
  jest.clearAllMocks();
  Object.values(authService).forEach((method) => jest.mocked(method).mockReset());
  login.mockReset(); refreshUser.mockReset();
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  jest.spyOn(Linking, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as ReturnType<typeof Linking.addEventListener>);
  jest.mocked(useAuth).mockReturnValue({ login, refreshUser, loading: false, error: null, clearError } as any);
  jest.mocked(authService.forgotPassword).mockResolvedValue({ message: 'Reset request accepted.' });
  jest.mocked(authService.signup).mockResolvedValue({ message: 'Check your email for a verification code.' });
  jest.mocked(authService.verifyEmail).mockResolvedValue({ authState: 'authenticated' } as any);
  jest.mocked(authService.resetPasswordByCode).mockResolvedValue({ authState: 'authenticated' } as any);
  jest.mocked(authService.resetPassword).mockResolvedValue({ authState: 'authenticated' } as any);
});
afterEach(() => jest.restoreAllMocks());

async function openReset() {
  await render(<AuthScreen />);
  await press('Forgot password?');
  await fill('Email', ' Fixture@Example.test ');
  await press('Send Reset Code');
  await fill('Reset Code', '123456');
  await fill('New Password', 'new-fixture-password');
  await fill('Confirm Password', 'new-fixture-password');
}

it('signs in with normalized email and the exact password', async () => {
  await render(<AuthScreen />);
  await fill('Email', ' Fixture@Example.test ');
  await fill('Password', ' fixture password ');
  await press('Sign In');
  expect(login).toHaveBeenCalledWith({ email: 'fixture@example.test', password: ' fixture password ' });
});

it('opens privacy and account-deletion instructions while signed out without sending auth requests', async () => {
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await render(<AuthScreen />);
  await fireEvent.press(screen.getByRole('link', { name: 'Privacy policy' }));
  await fireEvent.press(screen.getByRole('link', { name: 'Account deletion' }));
  expect(Linking.openURL).toHaveBeenNthCalledWith(1, 'https://assetinsightvaluator.com/privacy');
  expect(Linking.openURL).toHaveBeenNthCalledWith(2, 'https://assetinsightvaluator.com/account-deletion');
  expect(login).not.toHaveBeenCalled();
  expect(authService.signup).not.toHaveBeenCalled();
  expect(refreshUser).not.toHaveBeenCalled();
});

it('keeps privacy and account-deletion links reachable on signup and password recovery', async () => {
  await render(<AuthScreen />);
  await press('Create Account');
  expect(screen.getByRole('link', { name: 'Privacy policy' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Account deletion' })).toBeTruthy();
  await press('Sign In');
  await press('Forgot password?');
  expect(screen.getByRole('link', { name: 'Privacy policy' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Account deletion' })).toBeTruthy();
});

it('reopens verification after an unverified user signs in, and supports resend', async () => {
  login.mockRejectedValueOnce(Object.assign(new Error('Please verify your email before logging in.'), { code: 'EMAIL_NOT_VERIFIED' }));
  jest.mocked(authService.resendVerificationCode).mockResolvedValue({ message: 'Verification code resent.' });
  await render(<AuthScreen />);
  await fill('Email', 'fixture@example.test'); await fill('Password', 'fixture'); await press('Sign In');
  expect(screen.getByText('Verify Your Email')).toBeTruthy();
  await press("Didn't get a verification code? Resend verification code");
  expect(authService.resendVerificationCode).toHaveBeenCalledWith('fixture@example.test');
  await fill('Verification Code', '123456'); await press('Verify');
  expect(authService.verifyEmail).toHaveBeenCalledWith({ email: 'fixture@example.test', verificationCode: '123456' });
  expect(refreshUser).toHaveBeenCalledTimes(1);
});

it('keeps signup confirmation visible on the verification screen', async () => {
  await render(<AuthScreen />); await press('Create Account');
  await fill('Username', 'Fixture'); await fill('Email', 'fixture@example.test');
  await fill('Password', 'fixture'); await fill('Confirm Password', 'fixture');
  await press('Continue'); await press('Create Account');
  expect(authService.signup).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Check your email for a verification code.')).toBeTruthy();
  await fill('Verification Code', '123'); await press('Verify');
  expect(authService.verifyEmail).not.toHaveBeenCalled();
  expect(screen.getByText('Please enter the 6-digit verification code.')).toBeTruthy();
});

it('preserves reset inputs on a device error and allows explicit retry', async () => {
  await openReset();
  jest.mocked(authService.resetPasswordByCode).mockRejectedValueOnce({ response: { data: { message: 'Device could not be prepared. Please try again.' } } });
  await press('Reset Password');
  expect(screen.getByText('Device could not be prepared. Please try again.')).toBeTruthy();
  expect(screen.getByLabelText('Reset Code').props.value).toBe('123456');
  expect(screen.getByLabelText('New Password').props.value).toBe('new-fixture-password');
  expect(refreshUser).not.toHaveBeenCalled();
  await press('Reset Password');
  expect(authService.resetPasswordByCode).toHaveBeenCalledTimes(2);
  expect(authService.resetPasswordByCode).toHaveBeenLastCalledWith({ email: 'fixture@example.test', code: '123456', password: 'new-fixture-password' });
  expect(refreshUser).toHaveBeenCalledTimes(1);
});

it('does not replay a reset or navigate away during a pending submission', async () => {
  await openReset();
  const button = screen.getByText('Reset Password');
  jest.mocked(authService.resetPasswordByCode).mockImplementationOnce(async () => {
    await fireEvent.press(button);
    await press('Back to Sign In');
    expect(screen.getByLabelText('New Password')).toBeTruthy();
    return { authState: 'authenticated' } as any;
  });
  await act(async () => { await press('Reset Password'); });
  expect(authService.resetPasswordByCode).toHaveBeenCalledTimes(1);
});

it('does not advance or claim email success when the forgot request fails', async () => {
  jest.mocked(authService.forgotPassword).mockRejectedValueOnce(new Error('Connection unavailable'));
  await render(<AuthScreen />); await press('Forgot password?');
  await fill('Email', 'fixture@example.test'); await press('Send Reset Code');
  expect(screen.getByText('Connection unavailable')).toBeTruthy();
  expect(screen.getByText('Send Reset Code')).toBeTruthy();
  expect(screen.queryByLabelText('Reset Code')).toBeNull();
});

it('validates the complete reset code before sending', async () => {
  await openReset(); await fill('Reset Code', '123'); await press('Reset Password');
  expect(authService.resetPasswordByCode).not.toHaveBeenCalled();
  expect(screen.getByText('Please enter the 6-digit reset code.')).toBeTruthy();
});

it('opens a reset link without claiming it is valid and sends it only on submit', async () => {
  jest.mocked(Linking.getInitialURL).mockResolvedValueOnce('assetinsight://reset-password?token=fixture%2Ftoken');
  await render(<AuthScreen />);
  expect(screen.getByText('Reset link opened')).toBeTruthy();
  expect(authService.resetPassword).not.toHaveBeenCalled();
  await fill('New Password', 'fixture'); await fill('Confirm Password', 'fixture'); await press('Reset Password');
  expect(authService.resetPassword).toHaveBeenCalledWith({ token: 'fixture/token', password: 'fixture' });
});

it('ignores a malformed reset link without crashing', async () => {
  jest.mocked(Linking.getInitialURL).mockResolvedValueOnce('assetinsight://reset-password?token=%E0%A4%A');
  await render(<AuthScreen />);
  expect(screen.getByText('Welcome Back')).toBeTruthy();
  expect(authService.resetPassword).not.toHaveBeenCalled();
});

it.each(['verify', 'reset-code', 'reset-token'])('preserves the device approval screen after %s returns pending', async (flow) => {
  const restricted = { authState: 'pending', challengeToken: 'fixture-challenge' } as any;
  if (flow === 'verify') {
    login.mockRejectedValueOnce(Object.assign(new Error('Please verify your email before logging in.'), { code: 'EMAIL_NOT_VERIFIED' }));
    jest.mocked(authService.verifyEmail).mockResolvedValueOnce(restricted);
    await render(<AuthScreen />); await fill('Email', 'fixture@example.test'); await fill('Password', 'fixture'); await press('Sign In');
    await fill('Verification Code', '123456'); await press('Verify');
  } else if (flow === 'reset-code') {
    jest.mocked(authService.resetPasswordByCode).mockResolvedValueOnce(restricted);
    await openReset(); await press('Reset Password');
  } else {
    jest.mocked(Linking.getInitialURL).mockResolvedValueOnce('assetinsight://reset-password?token=fixture');
    jest.mocked(authService.resetPassword).mockResolvedValueOnce(restricted);
    await render(<AuthScreen />); await fill('New Password', 'fixture'); await fill('Confirm Password', 'fixture'); await press('Reset Password');
  }
  expect(refreshUser).not.toHaveBeenCalled();
});
