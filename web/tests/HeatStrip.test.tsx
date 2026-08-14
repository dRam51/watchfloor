// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { HeatStrip } from '../src/components/HeatStrip.tsx';
import { HEAT_STRIP_BUCKET_HOURS } from '../src/lib/heatStrip.ts';
import { makeFeedItem, mount, type Mounted } from './testUtils.tsx';

const NOW_MS = Date.parse('2026-08-14T18:00:00.000Z');
const HOUR_MS = 3_600_000;

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
});

describe('HeatStrip -- always renders a full strip, even with zero items (task brief DoD 2: "empty lanes read as quiet")', () => {
  it('renders HEAT_STRIP_BUCKET_HOURS bars for an empty lane, not a missing/collapsed element', () => {
    current = mount(<HeatStrip items={[]} now={NOW_MS} />);
    const bars = current.container.querySelectorAll('.heat-strip__bar');
    expect(bars).toHaveLength(HEAT_STRIP_BUCKET_HOURS);
    expect(current.container.querySelector('.heat-strip')).not.toBeNull();
  });

  it('labels a quiet lane distinctly from a loud one, via an accessible role/label (not color alone)', () => {
    current = mount(<HeatStrip items={[]} now={NOW_MS} />);
    const strip = current.container.querySelector('.heat-strip')!;
    expect(strip.getAttribute('role')).toBe('img');
    expect(strip.getAttribute('aria-label')).toBe('No activity in the last 24 hours');
  });
});

describe('HeatStrip -- reflects real activity', () => {
  it('reports a real total and a real bar count in its accessible label', () => {
    const items = [
      makeFeedItem({ publishedAt: new Date(NOW_MS - HOUR_MS).toISOString() }),
      makeFeedItem({ publishedAt: new Date(NOW_MS - 2 * HOUR_MS).toISOString() }),
    ];
    current = mount(<HeatStrip items={items} now={NOW_MS} />);
    const strip = current.container.querySelector('.heat-strip')!;
    expect(strip.getAttribute('aria-label')).toBe('2 items published in the last 24 hours');
  });

  it('uses singular phrasing for exactly one item', () => {
    const items = [makeFeedItem({ publishedAt: new Date(NOW_MS - HOUR_MS).toISOString() })];
    current = mount(<HeatStrip items={items} now={NOW_MS} />);
    expect(current.container.querySelector('.heat-strip')!.getAttribute('aria-label')).toBe(
      '1 item published in the last 24 hours',
    );
  });

  it('the busiest bucket gets the maximum --heat value (1), a quiet bucket gets 0', () => {
    const items = [
      makeFeedItem({ publishedAt: new Date(NOW_MS - HOUR_MS).toISOString() }),
      makeFeedItem({ publishedAt: new Date(NOW_MS - HOUR_MS).toISOString() }),
      makeFeedItem({ publishedAt: new Date(NOW_MS - HOUR_MS).toISOString() }),
    ];
    current = mount(<HeatStrip items={items} now={NOW_MS} />);
    const bars = Array.from(current.container.querySelectorAll<HTMLSpanElement>('.heat-strip__bar'));
    // Published exactly 1h before `now` lands in the FINAL bucket -- that
    // bucket spans the window's last hour, [now-1h, now] (see
    // heatStrip.test.ts's own placement tests for the general rule).
    const busiest = bars[HEAT_STRIP_BUCKET_HOURS - 1]!;
    const empty = bars[0]!; // the oldest bucket, nothing published there
    expect(busiest.style.getPropertyValue('--heat')).toBe('1');
    expect(empty.style.getPropertyValue('--heat')).toBe('0');
  });

  it('a historical catalog dump (all items outside the 24h window) renders identically to zero items -- quiet, not a false spike', () => {
    const dump = Array.from({ length: 300 }, () =>
      makeFeedItem({ publishedAt: new Date(NOW_MS - 90 * 24 * HOUR_MS).toISOString() }),
    );
    current = mount(<HeatStrip items={dump} now={NOW_MS} />);
    expect(current.container.querySelector('.heat-strip')!.getAttribute('aria-label')).toBe(
      'No activity in the last 24 hours',
    );
  });
});

describe('HeatStrip -- decorative bars stay out of the accessibility tree', () => {
  it('every individual bar is aria-hidden -- the strip-level role="img" carries the one accessible summary', () => {
    current = mount(<HeatStrip items={[]} now={NOW_MS} />);
    const bars = current.container.querySelectorAll('.heat-strip__bar');
    bars.forEach((bar) => expect(bar.getAttribute('aria-hidden')).toBe('true'));
  });
});
