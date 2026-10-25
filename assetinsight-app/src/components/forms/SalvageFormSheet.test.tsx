import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Localization from 'expo-localization';
import SalvageFormSheet from './SalvageFormSheet';
import salvageService from '../../services/salvageService';
import { Alert } from 'react-native';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../../context/AuthContext', () => {
  const value = { user: { username: 'Inspector', email: 'inspector@example.test' } };
  return { useAuth: () => value };
});
jest.mock('../../services/salvageService', () => ({ __esModule: true, default: { create: jest.fn(), getProgress: jest.fn() } }));
jest.mock('expo-localization', () => ({ getLocales: jest.fn(() => [{ languageTag: 'en-US', regionCode: 'US' }]) }));
jest.mock('expo-image-picker', () => ({ MediaTypeOptions: { Images: 'Images' }, launchImageLibraryAsync: jest.fn() }));

beforeEach(() => { jest.clearAllMocks(); jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });

const fillForm = async () => {
  const fields = { 'Enter file number': 'FILE42', 'Claim #': 'CLAIM42', 'Policy #': 'POLICY42', 'Enter insured name': 'Insured person', 'Enter adjuster name': 'Adjuster', Phone: '555-0100', 'Enter company name': 'Appraisal', 'Enter company address': 'Test address', 'Enter detailed comments about the salvage...': 'Inspect front damage.' };
  for (const [placeholder, value] of Object.entries(fields)) await fireEvent.changeText(screen.getByPlaceholderText(placeholder), value);
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///test.jpg', width: 100, height: 100 }] });
  await fireEvent.press(screen.getByText('Add Images (0/50)'));
};

it('retains all 50 selected photos and does not reopen an unlimited picker when full', async () => {
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: false, assets: Array.from({ length: 50 }, (_, index) => ({ uri: `file:///photo-${index}.jpg`, fileName: `photo-${index}.jpg`, mimeType: 'image/jpeg', width: 100, height: 100 })) });
  await render(<SalvageFormSheet visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Add Images (0/50)'));
  expect(screen.getByText('Add Images (50/50)')).toBeTruthy();
  await fireEvent.press(screen.getByText('Add Images (50/50)'));
  expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
  expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ selectionLimit: 50 }));
});

it('hands off the accepted report to its processing preview instead of claiming files are generated', async () => {
  const success = jest.fn();
  const close = jest.fn();
  jest.mocked(salvageService.create).mockResolvedValue({ message: 'Accepted', reportId: 'canonical-42', jobId: 'job-42', phase: 'processing' });
  await render(<SalvageFormSheet visible onClose={close} onSuccess={success} />);
  await fillForm();
  await fireEvent.press(screen.getByText('Upload & prepare preview'));
  expect(success).toHaveBeenCalledWith('canonical-42');
  expect(close).toHaveBeenCalledTimes(1);
  expect(salvageService.getProgress).not.toHaveBeenCalled();
  expect(salvageService.create).toHaveBeenCalledWith(expect.objectContaining({ client_submission_id: expect.stringMatching(/^salvage-mobile-/) }), expect.arrayContaining([expect.objectContaining({ uri: 'file:///test.jpg' })]), expect.any(Function), expect.any(AbortSignal));
});

it('retains inputs and retries with the same logical submission id after an unconfirmed upload', async () => {
  jest.mocked(salvageService.create).mockRejectedValue(new Error('Network connection interrupted'));
  await render(<SalvageFormSheet visible onClose={jest.fn()} />);
  await fillForm();
  await fireEvent.press(screen.getByText('Upload & prepare preview'));
  expect(screen.getByDisplayValue('FILE42')).toBeTruthy();
  expect(screen.getByText('Add Images (1/50)')).toBeTruthy();
  await fireEvent.press(screen.getByText('Upload & prepare preview'));
  expect(salvageService.create).toHaveBeenCalledTimes(2);
  const calls = jest.mocked(salvageService.create).mock.calls;
  expect(calls[0][0].client_submission_id).toBe(calls[1][0].client_submission_id);
  expect(Alert.alert).toHaveBeenCalledWith('Upload not confirmed', expect.stringContaining('Check Previews before starting another report'));
});

it('collects only Canadian assessment context and leaves vehicle identity to the photos', async () => {
  jest.mocked(salvageService.create).mockResolvedValue({ message: 'Accepted', reportId: 'canonical-vehicle' });
  await render(<SalvageFormSheet visible onClose={jest.fn()} />);
  await fillForm();
  for (const label of ['Vehicle year', 'Vehicle make', 'Vehicle model', 'Trim / edition', 'Engine / powertrain', 'VIN (if readable)', 'Odometer reading', 'Odometer unit km']) {
    expect(screen.queryByLabelText(label)).toBeNull();
  }
  expect(screen.getByText(/Vehicle details are read from your uploaded photos/)).toBeTruthy();
  for (const [label, value] of [
    ['Market province / territory', 'on'], ['City / local market', 'Ottawa'], ['Effective valuation date', '2026-09-08'],
    ['Type / cause of loss', 'Collision'], ['Documented vehicle brand', 'Salvage'], ['Brand document province / territory', 'ON'],
    ['Observed damage', 'Front bumper damaged'],
  ]) await fireEvent.changeText(screen.getByLabelText(label), value);
  await fireEvent.press(screen.getByText('Upload & prepare preview'));
  expect(salvageService.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'CAD', assessment_inputs: expect.objectContaining({
    province: 'ON', market: 'Ottawa', effectiveDate: '2026-09-08', lossType: 'Collision',
    documentedBrand: 'Salvage', brandProvince: 'ON', condition: null, damageDescription: 'Front bumper damaged', currency: 'CAD',
  }) }), expect.any(Array), expect.any(Function), expect.any(AbortSignal));
  const sentInputs = jest.mocked(salvageService.create).mock.calls[0][0].assessment_inputs;
  for (const key of ['year', 'make', 'model', 'trim', 'powertrain', 'vin', 'odometer', 'odometerUnit']) {
    expect(sentInputs).not.toHaveProperty(key);
  }
  expect(Localization.getLocales).not.toHaveBeenCalled();
});

it('does not submit an invalid Canadian province code or erase the captured photos', async () => {
  await render(<SalvageFormSheet visible onClose={jest.fn()} />);
  await fillForm();
  await fireEvent.changeText(screen.getByLabelText('Market province / territory'), 'XX');
  await fireEvent.press(screen.getByText('Upload & prepare preview'));
  expect(salvageService.create).not.toHaveBeenCalled();
  expect(screen.getByText('Use a valid Canadian province / territory code, or leave it blank.')).toBeTruthy();
  expect(screen.getByText('Add Images (1/50)')).toBeTruthy();
});
