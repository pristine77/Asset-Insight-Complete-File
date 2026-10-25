import { salvageDisplayText } from './salvageDisplayText';

it('uses neutral processing labels while retaining uncertainty and automation', () => {
  const input =
    'OpenAI GPT-6-astra AI-generated assessment incomplete: VIN unreadable. AI estimates require review.';
  const output = salvageDisplayText(input);
  expect(output).not.toMatch(/OpenAI|GPT|\bAI\b/);
  expect(output).toContain('automatically prepared assessment incomplete: VIN unreadable');
  expect(output).toContain('automated estimates require review');
  expect(input).toContain('OpenAI');
});
