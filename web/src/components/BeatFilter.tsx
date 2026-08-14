import { BEATS, type Beat } from '../api/types.ts';

/**
 * The beat filter chip row (task brief, DoD 1): reports a selection, does
 * NOT filter anything itself. `Stream.tsx` is the only thing that reacts to
 * `onChange`, and it reacts by issuing a fresh `GET /api/feed?beat=...`
 * request -- never by filtering an already-fetched array. Keeping this
 * component free of any array of items is what makes that structurally true
 * rather than merely intended: there is nothing here to filter.
 */

const BEAT_LABELS: Record<Beat, string> = {
  ai: 'AI',
  cyber: 'Cyber',
  aisec: 'AI Security',
  repos: 'Repos',
  markets: 'Markets',
  usnews: 'US News',
};

export interface BeatFilterProps {
  value: Beat | null;
  onChange: (beat: Beat | null) => void;
}

export function BeatFilter({ value, onChange }: BeatFilterProps) {
  return (
    <nav className="beat-filter" aria-label="Filter by beat">
      <button
        type="button"
        className="beat-filter__chip touch-target"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
      >
        All
      </button>
      {BEATS.map((beat) => (
        <button
          key={beat}
          type="button"
          className="beat-filter__chip touch-target"
          aria-pressed={value === beat}
          onClick={() => onChange(beat)}
        >
          {BEAT_LABELS[beat]}
        </button>
      ))}
    </nav>
  );
}
