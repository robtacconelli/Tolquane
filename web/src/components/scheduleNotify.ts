/**
 * Addresses, as people write them.
 *
 * A schedule's `notify.emails` is a list on the wire (docs/web-interfaces.md, N) and one
 * field on screen, because nobody wants a row each for two addresses. These three turn
 * one into the other and say when what was typed is not an address.
 */

const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Split on commas, semicolons or whitespace: all three are how a list gets written. */
export function parseEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter(Boolean);
}

export function emailsText(emails: readonly string[]): string {
  return emails.join(', ');
}

/** The addresses that are not ones; the server refuses the whole schedule otherwise. */
export function emailsError(text: string): string | null {
  const bad = parseEmails(text).filter((address) => !ADDRESS.test(address));
  return bad.length === 0 ? null : `Not an email address: ${bad.join(', ')}`;
}
