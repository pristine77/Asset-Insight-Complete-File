import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import realEstateService from '../../services/realEstateService';
import RealEstateFormSheet from './RealEstateFormSheet';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../../context/AuthContext', () => {
  const value = { user: { username: 'Inspector', email: 'inspector@example.test' } };
  return { useAuth: () => value };
});
jest.mock('../../services/realEstateService', () => ({ __esModule: true, default: { create: jest.fn(), getProgress: jest.fn() } }));
jest.mock('expo-image-picker', () => ({ MediaTypeOptions: { Images: 'Images' }, launchImageLibraryAsync: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///property.jpg', fileName: 'property.jpg', mimeType: 'image/jpeg', width: 100, height: 100 }] });
});

async function fillRequiredFields() {
  await fireEvent.changeText(screen.getByPlaceholderText('Enter owner name'), 'Owner');
  await fireEvent.changeText(screen.getByPlaceholderText('Enter full property address'), '123 Test Street');
  await fireEvent.press(screen.getByText('Add Images (0/50)'));
  await waitFor(() => expect(screen.getByText('Add Images (1/50)')).toBeTruthy());
}

it('renders agricultural approaches and preserves decimal/zero inputs in the accepted payload', async () => {
  jest.mocked(realEstateService.create).mockResolvedValue({ message: 'Accepted', jobId: 'job-1', phase: 'processing' });
  const onClose = jest.fn();
  const view = await render(<RealEstateFormSheet visible onClose={onClose} />);
  await fillRequiredFields();
  await fireEvent.press(screen.getByText('Agricultural'));
  await fireEvent(screen.getByLabelText('Income approach'), 'valueChange', true);
  await fireEvent.changeText(screen.getByLabelText('Market rent per acre'), '0');
  await fireEvent.changeText(screen.getByLabelText('Vacancy loss (%)'), '0');
  await fireEvent.changeText(screen.getByLabelText('Capitalization rate (%)'), '4.5');
  await fireEvent.press(screen.getByText('Submit Report'));
  await waitFor(() => expect(realEstateService.create).toHaveBeenCalledTimes(1));
  expect(jest.mocked(realEstateService.create).mock.calls[0][0]).toMatchObject({ property_type: 'agricultural', farmland_details: { use_direct_comparable: true, use_income_approach: true, use_cost_approach: false, market_rent_per_acre: 0, vacancy_loss_percent: 0, cap_rate: 4.5 } });
  expect(screen.getByText('Continue in background')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Submit real estate report'));
  expect(realEstateService.create).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByLabelText('Close real estate form'));
  expect(onClose).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Continue in background'));
  expect(onClose).toHaveBeenCalledTimes(1);
  await view.unmount();
});

it('retains the entered report/photos after upload failure', async () => {
  jest.mocked(realEstateService.create).mockRejectedValue(new Error('Upload interrupted'));
  await render(<RealEstateFormSheet visible onClose={jest.fn()} />);
  await fillRequiredFields();
  await fireEvent.press(screen.getByText('Submit Report'));
  expect(realEstateService.create).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByText('Submit Report')).toBeTruthy());
  expect(screen.getByPlaceholderText('Enter owner name').props.value).toBe('Owner');
  expect(screen.getByText('Add Images (1/50)')).toBeTruthy();
});

it('requires at least one agricultural valuation method', async () => {
  await render(<RealEstateFormSheet visible onClose={jest.fn()} />);
  await fillRequiredFields();
  await fireEvent.press(screen.getByText('Agricultural'));
  await fireEvent(screen.getByLabelText('Direct comparable approach'), 'valueChange', false);
  await fireEvent.press(screen.getByText('Submit Report'));
  expect(screen.getByText('Select at least one valuation approach.')).toBeTruthy();
  expect(realEstateService.create).not.toHaveBeenCalled();
});
