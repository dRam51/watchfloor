// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchBox } from '../src/components/SearchBox.tsx';
import { actKeyDown, mount, typeInto, type Mounted } from './testUtils.tsx';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
});

describe('SearchBox -- backward compatibility with its Task 9 uncontrolled usage', () => {
  it('renders as a plain uncontrolled input when value/onChange/onEscape are all omitted (Stream.tsx\'s exact call shape)', () => {
    current = mount(<SearchBox inputRef={() => {}} />);
    const input = current.container.querySelector<HTMLInputElement>('.search-box__input')!;
    expect(input).not.toBeNull();
    expect(input.value).toBe('');
  });

  it('still blurs on Escape with no onEscape supplied -- the original Task 9 behavior, unchanged', () => {
    current = mount(<SearchBox inputRef={() => {}} />);
    const input = current.container.querySelector<HTMLInputElement>('.search-box__input')!;
    input.focus();
    expect(document.activeElement).toBe(input);

    actKeyDown('Escape', {}, input);
    expect(document.activeElement).not.toBe(input);
  });
});

describe('SearchBox -- Task 11 wiring: controlled value/onChange/onEscape', () => {
  it('reflects a supplied value and reports keystrokes through onChange', () => {
    const onChange = vi.fn();
    current = mount(<SearchBox inputRef={() => {}} value="hello" onChange={onChange} />);
    const input = current.container.querySelector<HTMLInputElement>('.search-box__input')!;
    expect(input.value).toBe('hello');

    typeInto(input, 'hello world');
    expect(onChange).toHaveBeenCalledWith('hello world');
  });

  it('calls onEscape IN ADDITION TO blurring, never instead of it', () => {
    const onEscape = vi.fn();
    current = mount(<SearchBox inputRef={() => {}} value="q" onChange={() => {}} onEscape={onEscape} />);
    const input = current.container.querySelector<HTMLInputElement>('.search-box__input')!;
    input.focus();

    actKeyDown('Escape', {}, input);

    expect(onEscape).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(input);
  });
});
