import { describe, expect, it } from 'vitest';
import { stripSurrogates, safeJsonStringify } from './string-sanitize.js';

describe('stripSurrogates', () => {
  it('passes through clean strings unchanged', () => {
    expect(stripSurrogates('hello world')).toBe('hello world');
  });

  it('replaces lone high surrogates with U+FFFD', () => {
    expect(stripSurrogates('before\uD800after')).toBe('before\uFFFDafter');
  });

  it('replaces lone low surrogates with U+FFFD', () => {
    expect(stripSurrogates('a\uDFFFb')).toBe('a\uFFFDb');
  });

  it('replaces multiple surrogates', () => {
    expect(stripSurrogates('\uD800\uD801hello\uDC00')).toBe('\uFFFD\uFFFDhello\uFFFD');
  });

  it('handles empty string', () => {
    expect(stripSurrogates('')).toBe('');
  });
});

describe('safeJsonStringify', () => {
  it('produces valid JSON for normal objects', () => {
    const result = safeJsonStringify({ key: 'value', num: 42 });
    expect(JSON.parse(result)).toEqual({ key: 'value', num: 42 });
  });

  it('replaces JSON-escaped lone surrogates with \\uFFFD', () => {
    // ES2019+ JSON.stringify escapes lone surrogates as \uDXXX
    const result = safeJsonStringify({ text: 'hello\uD800world' });
    // The output should not contain \ud800 escape sequences
    expect(result).not.toMatch(/\\u[dD][89aAbB][0-9a-fA-F]{2}/);
    // It should contain \uFFFD escape sequences instead
    expect(result).toContain('\\uFFFD');
    // Must be valid JSON that Python can safely decode
    const parsed = JSON.parse(result);
    expect(parsed.text).toBe('hello\uFFFDworld');
  });

  it('handles nested objects with surrogates', () => {
    const result = safeJsonStringify({
      outer: { inner: 'data\uDBFFhere' },
    });
    expect(result).not.toMatch(/\\u[dD][89aAbB][0-9a-fA-F]{2}/);
    const parsed = JSON.parse(result);
    expect(parsed.outer.inner).toBe('data\uFFFDhere');
  });

  it('does not mangle real unicode characters', () => {
    const result = safeJsonStringify({ emoji: '😀', text: 'café' });
    const parsed = JSON.parse(result);
    expect(parsed.emoji).toBe('😀');
    expect(parsed.text).toBe('café');
  });
});
