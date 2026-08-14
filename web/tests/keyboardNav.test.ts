// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  beatForDigitKey,
  hasNavModifier,
  isEditableTarget,
  nextFocusIndex,
} from '../src/lib/keyboardNav.ts';

describe('isEditableTarget -- decides whether a keydown is "typing" (task brief, decision 4)', () => {
  it('is true for input, textarea, and select elements', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
  });

  it('is true for a contenteditable element even though its tag is not a form control', () => {
    const div = document.createElement('div');
    // jsdom (through at least v30) does not implement the contenteditable
    // content attribute / isContentEditable computation at all -- setting
    // either the attribute or the `.contentEditable` property leaves
    // `.isContentEditable` `undefined` regardless (verified directly against
    // this repo's jsdom version). Stubbing the property is the standard way
    // to test code that reads it without depending on jsdom growing that
    // feature; it still exercises isEditableTarget's own branch faithfully
    // -- a real browser sets this same property to `true` for an editing
    // host, which is all this function ever looks at.
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
    expect(isEditableTarget(div)).toBe(true);
  });

  it('is false for a button and a plain (non-editable) div -- row controls must stay reachable', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(document.createElement('a'))).toBe(false);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
  });

  it('is false for null and for a non-HTMLElement target', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });
});

describe('hasNavModifier -- lets system/browser shortcuts through untouched', () => {
  it('is true when Cmd/Ctrl/Alt is held', () => {
    expect(hasNavModifier({ metaKey: true, ctrlKey: false, altKey: false })).toBe(true);
    expect(hasNavModifier({ metaKey: false, ctrlKey: true, altKey: false })).toBe(true);
    expect(hasNavModifier({ metaKey: false, ctrlKey: false, altKey: true })).toBe(true);
  });

  it('is false with no modifiers -- the app\'s own bare-letter bindings', () => {
    expect(hasNavModifier({ metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });
});

describe('nextFocusIndex -- j/k index arithmetic (task brief, decision 3)', () => {
  it('enters at the first row on the first "j" (delta +1) when nothing is focused yet', () => {
    expect(nextFocusIndex(null, 1, 5)).toBe(0);
  });

  it('enters at the last row on the first "k" (delta -1) when nothing is focused yet', () => {
    expect(nextFocusIndex(null, -1, 5)).toBe(4);
  });

  it('returns null for an empty list regardless of direction or current index', () => {
    expect(nextFocusIndex(null, 1, 0)).toBeNull();
    expect(nextFocusIndex(2, -1, 0)).toBeNull();
  });

  it('moves by one in the requested direction from a real current index', () => {
    expect(nextFocusIndex(2, 1, 5)).toBe(3);
    expect(nextFocusIndex(2, -1, 5)).toBe(1);
  });

  it('clamps at the last index rather than wrapping to the first', () => {
    expect(nextFocusIndex(4, 1, 5)).toBe(4);
  });

  it('clamps at the first index rather than wrapping to the last', () => {
    expect(nextFocusIndex(0, -1, 5)).toBe(0);
  });
});

describe('beatForDigitKey -- 1-6 to beat (task brief, decision 1)', () => {
  it('maps 1-6 to the six beats in BEATS order exactly', () => {
    expect(beatForDigitKey('1')).toBe('ai');
    expect(beatForDigitKey('2')).toBe('cyber');
    expect(beatForDigitKey('3')).toBe('aisec');
    expect(beatForDigitKey('4')).toBe('repos');
    expect(beatForDigitKey('5')).toBe('markets');
    expect(beatForDigitKey('6')).toBe('usnews');
  });

  it('returns null for any key outside 1-6, including 0, 7, and a shifted "?" from "/"', () => {
    expect(beatForDigitKey('0')).toBeNull();
    expect(beatForDigitKey('7')).toBeNull();
    expect(beatForDigitKey('a')).toBeNull();
    expect(beatForDigitKey('?')).toBeNull();
  });
});
