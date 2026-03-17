/**
 * Sanitize strings that may contain unpaired UTF-16 surrogates.
 *
 * JS strings are sequences of UTF-16 code units.  JSON.stringify() can emit
 * \uDXXX escape sequences for lone surrogates which then crash downstream
 * consumers that try to encode the resulting text as UTF-8 (e.g. Python's
 * json.dumps(...).encode("utf-8")).  These helpers replace any lone surrogate
 * with U+FFFD (REPLACEMENT CHARACTER) before the string leaves the process.
 */

/**
 * Replace any *unpaired* UTF-16 surrogate with U+FFFD.
 * Properly paired surrogates (high followed by low) are left intact.
 */
export function stripSurrogates(text: string): string {
  // Lone high surrogate (not followed by low) OR lone low surrogate (not preceded by high)
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

/**
 * JSON.stringify() with surrogate sanitisation.
 *
 * ES2019+ JSON.stringify emits `\uDXXX` escape sequences (literal backslash-u)
 * for lone surrogates rather than raw surrogate code units.  Properly paired
 * surrogates are serialised as the actual character (e.g. 😀).  Python's
 * json.loads() would decode lone-surrogate escapes back into surrogate
 * codepoints, which then crash on .encode("utf-8").
 *
 * We replace the `\uDXXX` escape sequences emitted for lone surrogates with
 * `\uFFFD`.  Paired surrogates in the output are already real characters and
 * are not affected.
 */
export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value)
    // JSON-escaped lone surrogates: \uD800–\uDFFF
    .replace(/\\u[dD][89aAbB][0-9a-fA-F]{2}/g, '\\uFFFD');
}
