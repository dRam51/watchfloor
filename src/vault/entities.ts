/**
 * Entity notes — §8.1's managed-block tier (M5 task 7).
 *
 * > *Managed block* (`entities/`): the file contains
 * > `<!-- watchfloor:begin -->` / `<!-- watchfloor:end -->` markers. Sync
 * > replaces **only** the content between markers and leaves everything above
 * > and below untouched [...] If the markers are missing from an existing
 * > file, append them rather than overwriting — never clobber a file you
 * > didn't create.
 *
 * This module decides *what goes in the block* and *which file it goes in*.
 * The marker protocol itself, the frontmatter gate, containment, atomicity and
 * the caps all belong to task 4 (`./session.ts`, `./frontmatter.ts`,
 * `./paths.ts`), and nothing here opens a file: every write goes through
 * `VaultSession.writeEntityNote`.
 *
 * ## Refuses, never sanitises
 *
 * An entity name becomes a filename, and that is the whole hazard. Sanitising
 * `../../Architecture` into `Architecture.md` produces a request that
 * `resolveVaultPath` is *right* to accept — and the write lands on a name
 * matching one of the owner's twelve hand-authored notes. Sanitising also
 * merges: two entity names that clean up to the same filename would take turns
 * overwriting each other's block on every run, so the note would not even be
 * idempotent. Every unsafe name is therefore refused with a machine-readable
 * reason and reported, never repaired.
 */

export type EntityNameRefusal =
  | 'empty'
  | 'separator'
  | 'whitespace_edge'
  | 'control_char'
  | 'dot_leading'
  | 'reserved_char'
  | 'device_name'
  | 'too_long';

export class EntityNameError extends Error {
  readonly reason: EntityNameRefusal;
  readonly entity: string;
  constructor(reason: EntityNameRefusal, entity: string, detail: string) {
    super(`refusing entity name ${JSON.stringify(entity)}: ${detail} (${reason})`);
    this.name = 'EntityNameError';
    this.reason = reason;
    this.entity = entity;
  }
}

/**
 * Characters that must never appear in a name this module creates.
 *
 * Three groups, deliberately collapsed into one refusal because a caller can
 * act on none of them differently:
 *
 * - `: * ? " < > |` — illegal on Windows, and macOS's Finder displays `:` as
 *   `/`. Obsidian runs on both, and this vault syncs to devices we do not run.
 * - `[ ] # ^ |` — Obsidian's own link syntax. Related entities are rendered as
 *   `[[Name]]` wikilinks, and every one of these either breaks the link or
 *   silently turns part of the name into a heading reference, a block
 *   reference or an alias. Real corpus evidence that this is not hypothetical:
 *   `latent-space` publishes titles of the form `[AINews] ...`, and an
 *   extractor keying on bracketed or capitalised runs would hand us `[AINews]`.
 * - `%` is deliberately NOT here: it is legal everywhere, appears in real
 *   entity-shaped strings, and refusing it would buy nothing.
 */
const RESERVED_CHARS = /[:*?"<>|[\]#^]/;

/** `NUL`, `CON`, `COM1`… — device names on Windows, with or without a suffix. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * The longest filename this module will produce, in UTF-8 bytes.
 *
 * NAME_MAX is 255 bytes, but the number that actually binds is smaller and it
 * is not obvious: `atomicWrite` in `./session.ts` writes through a temp file
 * named `.watchfloor-tmp-<filename>.<pid>.<counter>`, which adds 24 or more
 * bytes. Measured in a real temp directory on this machine: a 243-byte
 * filename writes fine on its own and fails with **ENAMETOOLONG at 267 bytes**
 * once the temp prefix is on. A 255-byte cap would therefore refuse nothing
 * and still crash mid-run.
 *
 * 200 leaves 55 bytes of headroom — far more than any plausible pid and
 * counter — and is still an order of magnitude above a real entity name.
 */
const MAX_FILENAME_BYTES = 200;

const MARKDOWN_SUFFIX = '.md';

const DEL_CODE = 127;
const FIRST_PRINTABLE_CODE = 32;

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE || code === DEL_CODE) return true;
  }
  return false;
}

/**
 * The filename an entity maps to, or a refusal.
 *
 * Order matters only in deciding which reason a name breaking several rules is
 * reported under; every branch here refuses.
 */
export function entityFileName(entity: string): string {
  if (entity.trim() === '') {
    throw new EntityNameError('empty', entity, 'an entity name must not be blank');
  }
  if (entity.includes('/') || entity.includes('\\')) {
    // Refused rather than replaced. `../../Architecture` must never become a
    // plausible filename; it must become an error somebody can read.
    throw new EntityNameError('separator', entity, 'contains a path separator');
  }
  if (entity !== entity.trim()) {
    // Leading and trailing spaces are legal on POSIX and silently stripped by
    // Windows, so `"Anthropic "` and `"Anthropic"` are one file on one host and
    // two on another. Trimming here would merge two DB entities into one note.
    throw new EntityNameError('whitespace_edge', entity, 'has leading or trailing whitespace');
  }
  if (hasControlCharacter(entity)) {
    throw new EntityNameError('control_char', entity, 'contains a control character');
  }
  if (entity.startsWith('.')) {
    // `resolveVaultPath` refuses a dot-prefixed segment anyway; refusing here
    // gives the reason in terms of the entity rather than of a path the caller
    // never built.
    throw new EntityNameError('dot_leading', entity, 'starts with a dot');
  }
  if (RESERVED_CHARS.test(entity)) {
    throw new EntityNameError(
      'reserved_char',
      entity,
      'contains a character reserved by a filesystem or by Obsidian link syntax',
    );
  }
  if (WINDOWS_DEVICE_NAME.test(entity)) {
    throw new EntityNameError('device_name', entity, 'is a reserved device name on Windows');
  }

  // NFC for the name we create, exactly as `isContainedIn` uses NFC for the
  // comparison it makes: macOS matches filenames normalisation-insensitively
  // and Linux does not, so emitting one normal form is what makes "this entity
  // maps to this file" mean the same thing on both hosts.
  const fileName = `${entity.normalize('NFC')}${MARKDOWN_SUFFIX}`;
  const bytes = Buffer.byteLength(fileName, 'utf8');
  if (bytes > MAX_FILENAME_BYTES) {
    throw new EntityNameError(
      'too_long',
      entity,
      `would be ${bytes} bytes, over the ${MAX_FILENAME_BYTES}-byte cap that keeps the ` +
        'atomic-write temp name under NAME_MAX',
    );
  }
  return fileName;
}

/** The vault-relative path for an entity's note. Always inside `entities/`. */
export function entityNoteRelPath(entity: string): string {
  return `entities/${entityFileName(entity)}`;
}
