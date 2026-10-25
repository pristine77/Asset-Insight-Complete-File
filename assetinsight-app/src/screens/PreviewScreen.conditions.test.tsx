import React from 'react';
import { Alert, Platform, ScrollView, StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import PreviewScreen from './PreviewScreen';
import api from '../services/api';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('react-native/Libraries/Components/RefreshControl/RefreshControl', () => ({
  __esModule: true,
  default: (props: any) => {
    const View = require('react-native').View;
    return <View {...props} />;
  },
}));
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: require('react-native').View,
  Group: require('react-native').View,
  Path: () => null,
  Skia: {},
  ImageFormat: {},
}));
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/' }));
jest.mock('expo-sharing', () => ({}));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  MediaTypeOptions: { Images: 'Images' },
}));
jest.mock('../services/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn(), post: jest.fn() },
}));
jest.mock('../services/assetService', () => ({ __esModule: true, default: {} }));
jest.mock('../services/lotListingService', () => ({ __esModule: true, default: {} }));
jest.mock('../services/assignedApprovalService', () => ({ __esModule: true, default: {} }));
jest.mock('../components/FarmlandValuationSummary', () => () => null);

const onBack = jest.fn();
const fixture = (count = 100, clientName = 'Original client') => ({
  client_name: clientName,
  contract_no: '93530',
  currency: 'CAD',
  lots: Array.from({ length: count }, (_, index) => ({
    lot_id: `stable-${index}`,
    lot_number: String(index + 1),
    title: `Item ${index + 1}`,
    description: `First line ${index + 1}\nKeep second line`,
    details: 'Retain details',
    estimated_value: '18500',
    image_indexes: [index],
    image_urls: [`https://assetinsight.pro/photo-${index}.jpg`],
    cover_index: index,
    condition_report_selections: {
      condition: 'Starts and Runs',
      completeness: 'Has Keys',
      legal: 'No Title',
    },
    condition_report_specs: {
      'Running Condition': 'Starts and Runs',
      Notes: 'Keep original notes',
    },
  })),
});
let saved: ReturnType<typeof fixture>;
let other: ReturnType<typeof fixture>;
const wrapPreview = (data: ReturnType<typeof fixture>) => ({
  data: {
    data: {
      status: 'preview',
      preview_data: data,
      imageUrls: data.lots.map((lot) => lot.image_urls[0]),
      grouping_mode: 'Bundle',
    },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  saved = fixture();
  other = fixture(10, 'Other client');
  jest
    .mocked(api.get)
    .mockImplementation(async (url) =>
      url === '/asset/category-specs'
        ? { data: { data: { specs: [] } } }
        : wrapPreview(String(url).includes('other-report') ? other : saved)
    );
  jest.mocked(api.put).mockImplementation(async (_url, body) => {
    saved = structuredClone((body as { preview_data: ReturnType<typeof fixture> }).preview_data);
    return { data: { data: saved } };
  });
  jest.mocked(api.post).mockImplementation(async (_url, body) => {
    saved = structuredClone((body as { preview_data: ReturnType<typeof fixture> }).preview_data);
    return { data: { data: {} } };
  });
});
afterEach(() => jest.restoreAllMocks());

it.each(['Asset', 'LotListing'] as const)('hides narrative inputs but preserves their saved data when editing the %s Title', async reportType => {
  saved = fixture(2);
  const original = structuredClone(saved);
  const view = await render(<PreviewScreen reportId="title-authority" reportType={reportType} mode="pending" onBack={onBack} />);
  await screen.findByLabelText('Lot 1 title');
  expect(screen.queryByLabelText('Lot 1 description')).toBeNull();
  expect(screen.queryByLabelText('Lot 1 details')).toBeNull();
  expect(screen.getByLabelText('Lot 1, Notes')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Lot 1 title'), 'Reviewed title for export TEST');
  await save();
  expect(saved.lots[0]).toEqual({ ...original.lots[0], title: 'Reviewed title for export TEST' });
  expect(saved.lots[1]).toEqual(original.lots[1]);
  await view.unmount();
  await render(<PreviewScreen reportId="title-authority" reportType={reportType} mode="pending" onBack={onBack} />);
  expect((await screen.findByLabelText('Lot 1 title')).props.value).toBe('Reviewed title for export TEST');
  expect(screen.queryByLabelText('Lot 1 description')).toBeNull();
  expect(screen.queryByLabelText('Lot 1 details')).toBeNull();
});

it.each(['Asset', 'LotListing'] as const)('navigates all 142 %s lots and saves all 1824 photo references with first/last edits intact', async reportType => {
  saved = fixture(142);
  let nextImage = 0;
  saved.lots.forEach((lot, index) => {
    // 120 x 13 + 22 x 12 = 1824 unique photo references, including photos
    // beyond each card's thumbnail strip. Nothing may be sliced for Save.
    lot.image_indexes = Array.from({ length: index < 120 ? 13 : 12 }, () => nextImage++);
    lot.image_urls = lot.image_indexes.map(image => `https://assetinsight.pro/large-report-${image}.jpg`);
    lot.cover_index = lot.image_indexes[0];
  });
  const original = structuredClone(saved);
  jest.mocked(api.get).mockImplementation(async url => String(url).includes('category-specs')
    ? { data: { data: { specs: [] } } }
    : { data: { data: { ...wrapPreview(saved).data.data, imageUrls: saved.lots.flatMap(lot => lot.image_urls) } } });
  const measure = jest.spyOn(View.prototype, 'measureLayout').mockImplementation(function(this: View, _relative, onSuccess) {
    onSuccess(0, this.props.testID === 'preview-lot-142' ? 14200 : 100, 320, 500);
  });
  const scroll = jest.spyOn(ScrollView.prototype, 'scrollTo');
  const view = await render(<PreviewScreen reportId="large-report" reportType={reportType} mode="pending" onBack={onBack} />);
  await screen.findByLabelText('Lot 142 title');
  expect(screen.getAllByTestId(/^preview-lot-\d+$/)).toHaveLength(142);
  expect(screen.getByText('1824')).toBeTruthy();
  const top = within(screen.getByTestId('preview-lot-navigation-top'));
  const bottom = within(screen.getByTestId('preview-lot-navigation-bottom'));
  expect(top.getByText('Showing all 142 lots')).toBeTruthy();
  expect(bottom.getByText('End of all 142 lots')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Lot 1 title'), 'First lot edited, keep it');
  await fireEvent.press(top.getByRole('button', { name: 'Go to last lot' }));
  expect(scroll).toHaveBeenLastCalledWith({ y: 14200, animated: true });
  await fireEvent.changeText(screen.getByLabelText('Lot 142 title'), 'Last lot edited, keep it');
  await fireEvent.press(bottom.getByRole('button', { name: 'Go to first lot' }));
  expect(scroll).toHaveBeenLastCalledWith({ y: 100, animated: true });
  expect(measure).toHaveBeenCalledTimes(2);
  expect(api.post).not.toHaveBeenCalled();
  expect(api.put).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Lot 1 title').props.value).toBe('First lot edited, keep it');
  expect(screen.getByLabelText('Lot 142 title').props.value).toBe('Last lot edited, keep it');
  await save();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(saved.lots).toHaveLength(142);
  expect(saved.lots.map(lot => lot.lot_id)).toEqual(original.lots.map(lot => lot.lot_id));
  expect(saved.lots.map(lot => ({ urls: lot.image_urls, indexes: lot.image_indexes, cover: lot.cover_index })))
    .toEqual(original.lots.map(lot => ({ urls: lot.image_urls, indexes: lot.image_indexes, cover: lot.cover_index })));
  expect(new Set(saved.lots.flatMap(lot => lot.image_urls)).size).toBe(1824);
  expect(saved.lots[0].title).toBe('First lot edited, keep it');
  expect(saved.lots[141].title).toBe('Last lot edited, keep it');
  expect(saved.lots.map(lot => ({ description: lot.description, details: lot.details })))
    .toEqual(original.lots.map(lot => ({ description: lot.description, details: lot.details })));
  expect(saved.lots.slice(1, 141)).toEqual(original.lots.slice(1, 141));
  await view.unmount();
  await render(<PreviewScreen reportId="large-report" reportType={reportType} mode="pending" onBack={onBack} />);
  await screen.findByLabelText('Lot 142 title');
  expect(screen.getByLabelText('Lot 1 title').props.value).toBe('First lot edited, keep it');
  expect(screen.getByLabelText('Lot 142 title').props.value).toBe('Last lot edited, keep it');
}, 20000);

it('ignores an old lot jump measurement after switching report context', async () => {
  saved = fixture(2);
  let measured!: (x: number, y: number, width: number, height: number) => void;
  jest.spyOn(View.prototype, 'measureLayout').mockImplementation((_relative, onSuccess) => { measured = onSuccess; });
  const scroll = jest.spyOn(ScrollView.prototype, 'scrollTo');
  const view = await render(<PreviewScreen reportId="old-report" reportType="Asset" mode="pending" onBack={onBack} />);
  await screen.findByLabelText('Lot 2 title');
  await fireEvent.press(within(screen.getByTestId('preview-lot-navigation-top')).getByRole('button', { name: 'Go to last lot' }));
  await view.rerender(<PreviewScreen reportId="other-report" reportType="Asset" mode="pending" onBack={onBack} />);
  await screen.findByDisplayValue('Other client');
  await act(() => measured(0, 14200, 320, 500));
  expect(scroll).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['Asset', 'LotListing'] as const)('%s exposes Save without per-lot AI controls and keeps the photo viewer read-only', async reportType => {
  saved = fixture(1);
  saved.lots[0].image_urls.push('https://assetinsight.pro/second-photo.jpg');
  const retained = structuredClone(saved);
  await render(<PreviewScreen reportId="save-only" reportType={reportType} mode="pending" onBack={onBack} />);
  await screen.findByDisplayValue('93530');
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /Re-Generate/i })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  expect(jest.mocked(Alert.alert).mock.calls.at(-1)?.[1]).toContain('Nothing is re-read by the AI');
  expect(api.post).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'View lot 1 photo 1' }));
  const viewer = within(screen.getByTestId('preview-photo-viewer'));
  expect(viewer.queryByRole('button', { name: /remove|delete/i })).toBeNull();
  expect(viewer.getByText('1 / 2')).toBeTruthy();
  await fireEvent.press(viewer.getByRole('button', { name: 'Next photo' }));
  expect(viewer.getByText('2 / 2')).toBeTruthy();
  await fireEvent.press(viewer.getByRole('button', { name: 'Previous photo' }));
  await fireEvent.press(viewer.getByRole('button', { name: 'Close photo gallery' }));
  expect(saved).toEqual(retained);
  expect(api.post).not.toHaveBeenCalled();
  expect(api.put).not.toHaveBeenCalled();
});

it.each(['Asset', 'LotListing'] as const)('opens the %s Android photo picker with broad library access unavailable', async reportType => {
  const previousOS = Platform.OS;
  Platform.OS = 'android';
  try {
    saved = fixture(1);
    const retained = structuredClone(saved);
    jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockRejectedValue(new Error('Broad permission is not declared'));
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null });
    await render(<PreviewScreen reportId="picker-report" reportType={reportType} mode="pending" onBack={onBack} />);
    await screen.findByDisplayValue('93530');
    await fireEvent.press(screen.getByText('Add photos'));
    await waitFor(() => expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1));
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({
      allowsMultipleSelection: true, quality: 1,
    }));
    expect(saved).toEqual(retained);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  } finally {
    Platform.OS = previousOS;
  }
});

it.each(['Asset', 'LotListing'] as const)('saves and regenerates %s with one current snapshot and no separate save', async reportType => {
  saved = fixture(2);
  jest.mocked(api.get).mockImplementation(async url => String(url).includes('category-specs')
    ? { data: { data: { specs: [] } } }
    : { data: { data: { ...wrapPreview(saved).data.data, status: 'approved' } } });
  let finish!: (value: any) => void;
  jest.mocked(api.post).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const success = jest.fn();
  await render(<PreviewScreen reportId="combined" reportType={reportType} mode="pending" onBack={onBack} onSuccess={success} />);
  const contract = await screen.findByDisplayValue('93530');
  await fireEvent.changeText(contract, 'UPDATED-93530');
  expect(screen.queryByRole('button', { name: 'Save preview changes' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  const confirm = confirmGeneration();
  await act(() => { void confirm.onPress?.(); void confirm.onPress?.(); });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith(`/${reportType === 'Asset' ? 'asset' : 'lot-listing'}/combined/resubmit`, {
    preview_data: expect.objectContaining({ contract_no: 'UPDATED-93530', lots: saved.lots }),
  });
  expect(api.put).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await fireEvent.changeText(contract, 'DO NOT REPLACE IN-FLIGHT SNAPSHOT');
  expect(contract.props.value).toBe('UPDATED-93530');
  expect(screen.queryByRole('button', { name: 'Back from report preview' })).toBeNull();
  expect(onBack).not.toHaveBeenCalled();
  await act(async () => finish({ data: { data: {} } }));
  expect(success).toHaveBeenCalledTimes(1);
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Generating files...' })).toBeDisabled();
});

it('ignores a generation confirmation after refreshed data replaces its snapshot', async () => {
  await open(2);
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  const confirm = confirmGeneration();
  saved = { ...saved, contract_no: 'REFRESHED' };
  await fireEvent(screen.getByTestId('preview-refresh'), 'refresh');
  await screen.findByDisplayValue('REFRESHED');
  await act(async () => { await confirm.onPress?.(); });
  expect(api.post).not.toHaveBeenCalled();
});

it('submits Lot Listing without FMV or appraisal selection blocks while retaining saved data', async () => {
  saved = fixture(2);
  saved.lots[0].estimated_value = '';
  saved.lots[0].condition_report_selections = { condition: '', completeness: '', legal: '' };
  const original = structuredClone(saved);
  await render(<PreviewScreen reportId="listing-report" reportType="LotListing" mode="pending" onBack={onBack} />);
  await screen.findByDisplayValue('93530');
  expect(screen.queryByText('Required selections')).toBeNull();
  expect(screen.queryByText(/Running Condition for all lots/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /^Edit required selections/ })).toBeNull();
  await fireEvent.press(screen.getByText('Save'));
  const confirmation = jest.mocked(Alert.alert).mock.calls.find(([title]) => title === 'Save');
  expect(confirmation).toBeDefined();
  await act(async () => { await confirmation![2]!.find((button) => button.text === 'Save')!.onPress?.(); });
  expect(api.post).toHaveBeenCalledWith('/lot-listing/listing-report/submit-approval', {
    preview_data: expect.objectContaining({ lots: expect.arrayContaining([
      expect.objectContaining({ ...original.lots[0] }),
      expect.objectContaining({ ...original.lots[1] }),
    ]) }),
  });
  expect(api.put).not.toHaveBeenCalled();
});

async function open(count = 100) {
  saved = fixture(count);
  const view = await render(
    <PreviewScreen reportId="asset-report" reportType="Asset" mode="pending" onBack={onBack} />
  );
  await screen.findByText(`0 of ${count} lots selected`);
  return view;
}
const select = (lot: number) =>
  fireEvent.press(screen.getByRole('checkbox', { name: `Select lot ${lot} for bulk update` }));
const apply = (group: string, value: string) =>
  fireEvent.press(screen.getByRole('button', { name: `${group}: ${value} to selected lots` }));
const confirmGeneration = () => jest.mocked(Alert.alert).mock.calls
  .filter(([title]) => title === 'Save')
  .at(-1)![2]!.find(button => button.text === 'Save')!;
const save = async () => {
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  await act(async () => { await confirmGeneration().onPress?.(); });
};

it.each(['Asset', 'LotListing'] as const)('submits %s spec edits, blanks and deletion authority without changing originals', async reportType => {
  saved = fixture(1);
  Object.assign(saved.lots[0], { categories: 'Equipment', condition_report_specs_reviewed: true,
    condition_report_specs: { Length: '10 ft', Width: '5 ft', Height: '6 ft', Notes: 'Scratches visible on left side' },
    condition_report_specs_manual_overrides: { Length: 'old length', Width: 'old width', Height: 'old height' },
    hidden_condition_report_specs: { Length: true, Colour: true },
  });
  const original = structuredClone(saved.lots[0]);
  jest.mocked(api.get).mockImplementation(async url => String(url).includes('category-specs')
    ? { data: { data: { specs: [{ childCategory: 'Equipment', parentCategory: 'Assets', fields: ['Overall Length', 'Overall Width', 'Overall Height'] }] } } }
    : wrapPreview(saved));
  await render(<PreviewScreen reportId="spec-authority" reportType={reportType} mode="pending" onBack={onBack} />);
  await screen.findByLabelText('Lot 1, Overall Length');
  await fireEvent.changeText(screen.getByLabelText('Lot 1, Overall Length'), '12 ft');
  await fireEvent.press(screen.getByRole('button', { name: 'Remove Overall Width' }));
  await fireEvent.changeText(screen.getByLabelText('Lot 1, Overall Height'), '');
  await save();
  const edited = saved.lots[0] as any;
  expect(edited.condition_report_specs).toEqual({ 'Overall Length': '12 ft', 'Overall Height': '', Notes: 'Scratches visible on left side' });
  expect(edited.condition_report_specs_manual_overrides).toEqual({ 'Overall Length': '12 ft', 'Overall Width': '', 'Overall Height': '' });
  expect(edited.condition_report_specs_deleted).toEqual(['Overall Width']);
  expect(edited.hidden_condition_report_specs).toEqual({ Colour: true });
  expect(edited.image_urls).toEqual(original.image_urls); expect(edited.lot_id).toBe(original.lot_id);
  expect(edited.description).toBe(original.description);
});

it.each(['Asset', 'LotListing'] as const)('reopens an explicitly empty reviewed %s without regenerated category placeholders', async reportType => {
  saved = fixture(1);
  Object.assign(saved.lots[0], { categories: 'Equipment', condition_report_specs_reviewed: true, condition_report_specs: {} });
  jest.mocked(api.get).mockImplementation(async url => String(url).includes('category-specs')
    ? { data: { data: { specs: [{ childCategory: 'Equipment', parentCategory: 'Assets', fields: ['Overall Length'] }] } } }
    : wrapPreview(saved));
  await render(<PreviewScreen reportId="spec-empty" reportType={reportType} mode="pending" onBack={onBack} />);
  await screen.findByDisplayValue('93530');
  expect(screen.queryByLabelText('Lot 1, Overall Length')).toBeNull();
  expect(screen.getByRole('button', { name: 'Add condition report field to lot 1' })).toBeTruthy();
  await save();
  expect(saved.lots[0].condition_report_specs).toEqual({});
});

it.each(['Asset', 'LotListing'] as const)('deletes the last %s spec, reopens empty, and explicitly re-adds it without an old override', async reportType => {
  saved = fixture(1);
  Object.assign(saved.lots[0], { condition_report_specs_reviewed: true, condition_report_specs: { Notes: 'Old note' }, condition_report_specs_manual_overrides: { Notes: 'Older note' } });
  const originals = structuredClone(saved.lots[0].image_urls);
  const view = await render(<PreviewScreen reportId="spec-reentry" reportType={reportType} mode="pending" onBack={onBack} />);
  await screen.findByLabelText('Lot 1, Notes');
  await fireEvent.press(screen.getByRole('button', { name: 'Remove Notes' }));
  await save();
  expect(saved.lots[0].condition_report_specs).toEqual({});
  await view.unmount();
  await render(<PreviewScreen reportId="spec-reentry" reportType={reportType} mode="pending" onBack={onBack} />);
  await screen.findByDisplayValue('93530');
  expect(screen.queryByLabelText('Lot 1, Notes')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Add condition report field to lot 1' }));
  await fireEvent.changeText(screen.getByLabelText('Condition report field name'), 'Notes');
  await fireEvent.changeText(screen.getByLabelText('Condition report field value'), 'New reviewed note');
  await fireEvent.press(screen.getByRole('button', { name: 'Save condition report field' }));
  await save();
  expect(saved.lots[0].condition_report_specs).toEqual({ Notes: 'New reviewed note' });
  expect((saved.lots[0] as any).condition_report_specs_manual_overrides).toEqual({ Notes: 'New reviewed note' });
  expect((saved.lots[0] as any).condition_report_specs_deleted).toEqual([]);
  expect(saved.lots[0].image_urls).toEqual(originals);
});

it('applies all three groups only to lots4/8/9 in a100-lot preview and saves/reopens the same values and media', async () => {
  const view = await open();
  const original = structuredClone(saved);
  expect(
    screen.getAllByRole('button', { name: /^Edit required selections for lot / })
  ).toHaveLength(100);
  expect(screen.queryByRole('button', { name: 'Legal: Salvage for lot 4' })).toBeNull();
  await select(4);
  await select(8);
  await select(9);
  expect(screen.getByText('3 of 100 lots selected')).toBeTruthy();
  await apply('Running Condition', 'Does not Start or Run');
  await apply('Completeness', 'Missing Parts');
  await apply('Legal', 'Salvage');
  await save();
  const payload = (
    jest.mocked(api.post).mock.calls[0][1] as { preview_data: ReturnType<typeof fixture> }
  ).preview_data;
  expect(payload.lots).toHaveLength(100);
  payload.lots.forEach((lot: any, index: number) => {
    expect(lot.description).toBe(original.lots[index].description);
    expect(lot.image_urls).toEqual(original.lots[index].image_urls);
    expect(lot.image_indexes).toEqual(original.lots[index].image_indexes);
    expect(lot.cover_index).toBe(index);
    expect(lot.lot_number).toBe(String(index + 1));
    expect(lot.condition_report_selections).toEqual(
      [3, 7, 8].includes(index)
        ? { condition: 'Does not Start or Run', completeness: 'Missing Parts', legal: 'Salvage' }
        : original.lots[index].condition_report_selections
    );
  });
  expect(screen.getByText('0 of 100 lots selected')).toBeTruthy();
  await view.unmount();
  await render(
    <PreviewScreen reportId="asset-report" reportType="Asset" mode="pending" onBack={onBack} />
  );
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Edit required selections for lot 8' })
  );
  expect(
    screen.getByRole('button', { name: 'Legal: Salvage for lot 8' }).props.accessibilityState
      .selected
  ).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Completeness: Missing Parts for lot 8' }).props
      .accessibilityState.selected
  ).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Running Condition: Does not Start or Run for lot 8' }).props
      .accessibilityState.selected
  ).toBe(true);
});

it('selects all100 lots, applies every group, and preserves an individual override for lot8', async () => {
  await open();
  await fireEvent.press(screen.getByRole('button', { name: 'Select all 100 lots' }));
  expect(screen.getByText('100 of 100 lots selected')).toBeTruthy();
  for (const group of ['Running Condition', 'Completeness', 'Legal']) await apply(group, 'N/A');
  await fireEvent.press(screen.getByRole('button', { name: 'Edit required selections for lot 8' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Legal: No Title for lot 8' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Completeness: Has Keys for lot 8' }));
  await fireEvent.press(
    screen.getByRole('button', { name: 'Running Condition: Starts and Runs for lot 8' })
  );
  await save();
  expect(saved.lots.filter((lot) => lot.condition_report_selections.legal === 'N/A')).toHaveLength(
    99
  );
  expect(saved.lots[7].condition_report_selections).toEqual({
    condition: 'Starts and Runs',
    completeness: 'Has Keys',
    legal: 'No Title',
  });
  expect(saved.lots[0].condition_report_specs).toEqual({ Notes: 'Keep original notes' });
  expect(saved.lots[7].condition_report_specs['Running Condition']).toBe('Starts and Runs');
});

it('clears selection explicitly and when deleting a lot so remaining indexes cannot retarget', async () => {
  await open(10);
  await select(4);
  await select(8);
  await select(9);
  await fireEvent.press(screen.getByRole('button', { name: 'Clear lot selection' }));
  expect(screen.getByText('0 of 10 lots selected')).toBeTruthy();
  await select(4);
  await select(8);
  await select(9);
  await fireEvent.press(screen.getByRole('button', { name: 'Delete lot 4' }));
  const buttons = jest
    .mocked(Alert.alert)
    .mock.calls.find(([title]) => title === 'Delete Lot')![2]!;
  await act(() => buttons.find((button) => button.text === 'Delete')!.onPress?.());
  expect(screen.getByText('0 of 9 lots selected')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Legal: Salvage to selected lots' }).props.accessibilityState
      .disabled
  ).toBe(true);
  await select(8);
  await apply('Legal', 'Salvage');
  await save();
  expect(
    saved.lots
      .filter((lot) => lot.condition_report_selections.legal === 'Salvage')
      .map((lot) => lot.lot_id)
  ).toEqual(['stable-7']);
});

it('clears selection and individual editors on refresh/reordered preview data', async () => {
  await open(10);
  await select(4);
  await fireEvent.press(screen.getByRole('button', { name: 'Edit required selections for lot 4' }));
  saved = { ...saved, lots: [...saved.lots].reverse() };
  await fireEvent(screen.getByTestId('preview-refresh'), 'refresh');
  await screen.findByText('0 of 10 lots selected');
  expect(
    screen.getByRole('checkbox', { name: 'Select lot 4 for bulk update' }).props.accessibilityState
      .checked
  ).toBe(false);
  expect(screen.queryByRole('button', { name: 'Legal: Salvage for lot 4' })).toBeNull();
});

it('does not let a late save response overwrite another report or its new selection', async () => {
  const view = await open(10);
  let resolveSave!: (data: any) => void;
  jest.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      })
  );
  await select(4);
  await apply('Legal', 'Salvage');
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  await act(() => { void confirmGeneration().onPress?.(); });
  expect(screen.getByText('0 of 10 lots selected', { includeHiddenElements: true })).toBeTruthy();
  expect(
    screen.getByRole('checkbox', { name: 'Select lot 8 for bulk update', includeHiddenElements: true }).props.accessibilityState
      .disabled
  ).toBe(true);
  await view.rerender(
    <PreviewScreen reportId="other-report" reportType="Asset" mode="pending" onBack={onBack} />
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Client Name *').props.value).toBe('Other client')
  );
  await select(9);
  await act(async () => {
    resolveSave({ data: { data: saved } });
  });
  expect(screen.getByLabelText('Client Name *').props.value).toBe('Other client');
  expect(screen.getByText('1 of 10 lots selected')).toBeTruthy();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(onBack).not.toHaveBeenCalled();
});

it('keeps edited values after save failure but resets the selection for a deliberate retry', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await open(10);
  jest.mocked(api.post).mockRejectedValueOnce(new Error('offline'));
  await select(4);
  await apply('Legal', 'Salvage');
  await save();
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Error', 'Failed to submit report'));
  expect(screen.getByText('0 of 10 lots selected')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Edit required selections for lot 4' }));
  expect(
    screen.getByRole('button', { name: 'Legal: Salvage for lot 4' }).props.accessibilityState
      .selected
  ).toBe(true);
  log.mockRestore();
});

it('keeps the single-lot editor available without a bulk panel', async () => {
  saved = fixture(1);
  await render(
    <PreviewScreen reportId="asset-report" reportType="Asset" mode="pending" onBack={onBack} />
  );
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Edit required selections for lot 1' })
  );
  expect(screen.queryByText('Update selected lots')).toBeNull();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Completeness: Missing Parts for lot 1' })
  );
  await save();
  expect(saved.lots[0].condition_report_selections.completeness).toBe('Missing Parts');
});

it('clears both visible condition spec aliases immediately when Asset Running Condition is N/A', async () => {
  saved = fixture(2);
  saved.lots[0].condition_report_specs = {
    'Running Condition': 'Old',
    'Working Condition': 'Stale',
    Notes: 'Keep original notes',
  } as any;
  await render(
    <PreviewScreen reportId="asset-report" reportType="Asset" mode="pending" onBack={onBack} />
  );
  await fireEvent.press(await screen.findByRole('button', { name: 'Select all 2 lots' }));
  await apply('Running Condition', 'N/A');
  expect(screen.queryByDisplayValue('Stale')).toBeNull();
  expect(screen.queryByDisplayValue('Old')).toBeNull();
  const option = screen.getByRole('button', { name: 'Legal: Salvage to selected lots' });
  expect(StyleSheet.flatten(option.props.style)).toMatchObject({
    minHeight: 44,
    maxWidth: '100%',
    flexShrink: 1,
  });
  expect(
    StyleSheet.flatten(
      screen.getByRole('checkbox', { name: 'Select lot 1 for bulk update' }).props.style
    )
  ).toMatchObject({ minHeight: 44, minWidth: 44 });
  await save();
  expect(saved.lots[0].condition_report_specs).toEqual({ Notes: 'Keep original notes' });
});

it('ignores an old delete confirmation after refreshed lot order replaces its target', async () => {
  await open(10);
  await fireEvent.press(screen.getByRole('button', { name: 'Delete lot 4' }));
  const confirm = jest
    .mocked(Alert.alert)
    .mock.calls.find(([title]) => title === 'Delete Lot')![2]!
    .find((button) => button.text === 'Delete')!;
  saved = { ...saved, lots: [...saved.lots].reverse() };
  await fireEvent(screen.getByTestId('preview-refresh'), 'refresh');
  await screen.findByText('0 of 10 lots selected');
  await act(() => confirm.onPress?.());
  expect(screen.getByText('0 of 10 lots selected')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Select lot 4 for bulk update' })).toBeTruthy();
});
