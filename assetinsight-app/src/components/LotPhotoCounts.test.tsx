import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import LotPhotoCounts from './LotPhotoCounts';
import OfflineCapturePanel from './forms/OfflineCapturePanel';
import type { MixedLot, PhotoFile } from './camera/types';

jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { text: '#111', textSecondary: '#555', border: '#ccc', accent: '#900', danger: '#b00' } }) }));
afterEach(async () => { await cleanup(); });
const lot = (id: number, count = 10) => ({ id: `lot-${id}`, lotNumber: String(id), images: count, extraImages: 0, missingImages: 0 });

it('shows each saved number, total and report-only/missing breakdown without renumbering', async () => {
  await render(<LotPhotoCounts lots={[lot(1), lot(2, 13), lot(3, 14), lot(5, 8), { ...lot(9, 7), lotNumber: 'X', extraImages: 2, missingImages: 1 }]} />);
  for (const text of ['Lot 1 · 10 images', 'Lot 2 · 13 images', 'Lot 3 · 14 images', 'Lot 5 · 8 images', 'Lot X · 7 images', '5 main · 2 report-only', '1 missing — original files need attention']) expect(screen.getByText(text)).toBeTruthy();
});
it('bounds large lists, retains positional fallback and recovers after lots are removed', async () => {
  const lots = Array.from({ length: 100 }, (_, i) => ({ ...lot(i + 1, 50), lotNumber: '' }));
  const view = await render(<LotPhotoCounts lots={lots} />);
  expect(screen.getAllByText(/ · 50 images/)).toHaveLength(10);
  expect(screen.getByText('Lots 1–10 of 100')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Next lots' }));
  expect(screen.getByText('Lot 11 · 50 images')).toBeTruthy();
  await view.rerender(<LotPhotoCounts lots={lots.slice(0, 3)} />);
  expect(screen.getByText('Lot 1 · 50 images')).toBeTruthy();
  expect(screen.queryByText('Lot 11 · 50 images')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Photos by lot' }));
  expect(screen.queryByText('Lot 1 · 50 images')).toBeNull();
});
it.each(['online', 'offline'] as const)('updates counts in %s forms, ignoring cover/thumbnail/video copies', async mode => {
  const photo = { uri: 'original', thumbnailUri: 'thumbnail', editedUri: 'edit', availability: 'missing' } as PhotoFile;
  const lots: MixedLot[] = [{ id: 'a', lotNumber: '0', files: [photo, { ...photo, availability: 'available' }], extraFiles: [photo], videoFile: photo, coverIndex: 1 }];
  const save = jest.fn(), change = jest.fn();
  const view = await render(<OfflineCapturePanel mode={mode} onChange={change} lots={lots} onSave={save} />);
  expect(screen.getByText('Lot 0 · 3 images')).toBeTruthy(); expect(screen.getByText('2 main · 1 report-only')).toBeTruthy();
  expect(screen.getByText('2 missing — original files need attention')).toBeTruthy();
  await view.rerender(<OfflineCapturePanel mode={mode} onChange={change} lots={[{ ...lots[0], files: [], extraFiles: [] }]} onSave={save} />);
  expect(screen.getByText('Lot 0 · 0 images')).toBeTruthy(); expect(save).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
});
it('shows an explicit empty state', async () => {
  await render(<LotPhotoCounts lots={[]} />); expect(screen.getByText('No lots yet.')).toBeTruthy();
});
