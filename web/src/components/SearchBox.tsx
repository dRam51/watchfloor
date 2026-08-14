/**
 * The pointer/keyboard-shared affordance for `/` (M3 task 9, §7: "/
 * search"). Task 9 shipped it deliberately minimal -- no value, no submit,
 * no API call -- as the least needed to prove `/` moves focus correctly
 * without leaking a slash into the field. This is Task 11's ("Search UI +
 * source health page", Wave 4) wiring pass: `value`/`onChange`/`onEscape`
 * are the extension points that doc comment promised, all OPTIONAL so the
 * one existing call site (Stream.tsx's toolbar, M3 task 9, out of this
 * task's ownership per the Wave 4 concurrency note) keeps compiling and
 * behaving exactly as before without being touched -- an input rendered
 * with neither prop is uncontrolled, matching Task 9's original behavior
 * bit for bit. `web/src/components/SearchView.tsx` is the real, functional
 * caller: it supplies `value`/`onChange` (its own query state) and renders
 * the results panel itself -- deliberately NOT inside this component, so
 * SearchBox stays the lean, reusable input Stream.tsx already depends on
 * rather than growing a dropdown that would intrude on a toolbar layout
 * this task does not own.
 */
export interface SearchBoxProps {
  /** Ref-callback, not a RefObject -- matches ItemRow's `toggleRef` so
   * every ref-plumbing in this tree uses one style, not two. Callers use
   * this to focus the field programmatically (Stream.tsx on `/`; SearchView
   * on mount). */
  inputRef: (el: HTMLInputElement | null) => void;
  /** Controlled value. Omit to keep the original Task 9 uncontrolled/inert
   * input (Stream.tsx's toolbar instance does exactly this). */
  value?: string;
  /** Fires on every keystroke, mirroring a plain `<input onChange>` but
   * pre-unwrapped to the string value -- every caller of this wants the
   * string, never the SyntheticEvent. Required together with `value`
   * (React treats an input with `value` but no `onChange` as read-only and
   * warns); optional as a pair so an uncontrolled caller supplies neither. */
  onChange?: (value: string) => void;
  /** Called in ADDITION to this component's own blur-on-Escape (never a
   * replacement for it) -- lets a wrapping view close or hand focus
   * elsewhere. Optional: Stream.tsx's inert instance has nothing to close. */
  onEscape?: () => void;
}

export function SearchBox({ inputRef, value, onChange, onEscape }: SearchBoxProps) {
  return (
    <input
      ref={inputRef}
      type="search"
      className="search-box__input touch-target"
      placeholder="Search all beats… (press /)"
      aria-label="Search items"
      value={value}
      onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      onKeyDown={(event) => {
        // Scoped to this element only -- Escape returns the keyboard to row
        // navigation without needing a second global binding. Every other
        // key (including the navigation letters and digits) is deliberately
        // left alone: Stream.tsx's global listener already ignores keydowns
        // whose target is a text input (see isEditableTarget in
        // lib/keyboardNav.ts), so typing a real query -- slashes and all --
        // is never intercepted once focus is already here.
        if (event.key === 'Escape') {
          event.currentTarget.blur();
          onEscape?.();
        }
      }}
    />
  );
}
