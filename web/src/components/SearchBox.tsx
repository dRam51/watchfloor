/**
 * The pointer/keyboard-shared affordance for `/` (M3 task 9, §7: "/
 * search"). Deliberately minimal: Task 11 ("Search UI + source health
 * page", Wave 4) owns querying `GET /api/search` and rendering results --
 * this task's job is only the KEYBINDING and FOCUS correctness (task brief,
 * decision 4: "`/` must not type a slash into the search box it opens"),
 * which cannot be built, let alone tested, without a real focusable field
 * for it to target. Task 11 extends this exact input (adds `value`,
 * `onChange`, a results panel) rather than replacing it -- the id and the
 * ref-callback contract below are the extension points.
 *
 * Uncontrolled on purpose: with nothing to submit yet, holding its value in
 * React state would be state with no reader, and controlled-vs-uncontrolled
 * is exactly the kind of decision that should be made once real submit
 * logic exists (Task 11), not guessed at here.
 */
export interface SearchBoxProps {
  /** Ref-callback, not a RefObject -- matches ItemRow's `toggleRef` so
   * Stream.tsx has one ref-plumbing style, not two. Stream calls
   * `.focus()` on the captured element when `/` is pressed. */
  inputRef: (el: HTMLInputElement | null) => void;
}

export function SearchBox({ inputRef }: SearchBoxProps) {
  return (
    <input
      ref={inputRef}
      type="search"
      className="search-box__input touch-target"
      placeholder="Search all beats… (press /)"
      aria-label="Search items"
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
        }
      }}
    />
  );
}
