// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeatFilter } from '../src/components/BeatFilter.tsx';
import { mount, type Mounted } from './testUtils.tsx';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
});

describe('BeatFilter', () => {
  it('renders an "All" chip plus one per beat, all >=44px touch targets', () => {
    current = mount(<BeatFilter value={null} onChange={() => {}} />);
    const chips = current.container.querySelectorAll('.beat-filter__chip');
    // "All" + 6 beats (ai, cyber, aisec, repos, markets, usnews)
    expect(chips).toHaveLength(7);
    chips.forEach((chip) => expect(chip.classList.contains('touch-target')).toBe(true));
    expect(current.container.textContent).toContain('All');
    expect(current.container.textContent).toContain('AI Security');
    expect(current.container.textContent).toContain('US News');
  });

  it('marks only the selected chip aria-pressed, "All" pressed when value is null', () => {
    current = mount(<BeatFilter value={null} onChange={() => {}} />);
    const buttons = Array.from(current.container.querySelectorAll('button'));
    const all = buttons.find((b) => b.textContent === 'All')!;
    expect(all.getAttribute('aria-pressed')).toBe('true');
    buttons
      .filter((b) => b !== all)
      .forEach((b) => expect(b.getAttribute('aria-pressed')).toBe('false'));
  });

  it('marks the matching beat chip pressed when a beat is selected', () => {
    current = mount(<BeatFilter value="cyber" onChange={() => {}} />);
    const buttons = Array.from(current.container.querySelectorAll('button'));
    const cyber = buttons.find((b) => b.textContent === 'Cyber')!;
    const all = buttons.find((b) => b.textContent === 'All')!;
    expect(cyber.getAttribute('aria-pressed')).toBe('true');
    expect(all.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the clicked beat via onChange without filtering anything itself', () => {
    const onChange = vi.fn();
    current = mount(<BeatFilter value={null} onChange={onChange} />);
    const buttons = Array.from(current.container.querySelectorAll('button'));
    const aisec = buttons.find((b) => b.textContent === 'AI Security')!;
    aisec.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('aisec');
  });

  it('reports null when "All" is clicked', () => {
    const onChange = vi.fn();
    current = mount(<BeatFilter value="markets" onChange={onChange} />);
    const buttons = Array.from(current.container.querySelectorAll('button'));
    const all = buttons.find((b) => b.textContent === 'All')!;
    all.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });
});
