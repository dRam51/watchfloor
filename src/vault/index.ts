/**
 * The vault safety layer (M5 task 4) — the one door into the owner's Obsidian
 * vault.
 *
 * **Every later vault task writes through this package and nothing else.**
 * Tasks 5–9 (daily notes, weekly notes, entity notes, saved promotion, verify
 * and prune) must import from here and must not import `node:fs`;
 * `tests/vault/sourceProperties.test.ts` fails if one does.
 *
 * The rule that outranks everything else in M5, from §8.1:
 *
 * > Watchfloor owns exactly one subtree and never writes outside it.
 * > - Never write to `notes/` or any hand-authored directory.
 * > - Never delete a file outside `watchfloor/`.
 * > - Never modify a file lacking Watchfloor frontmatter.
 *
 * Each of those is a primitive here rather than a caution in a doc comment:
 *
 * | rule | where it is enforced |
 * | --- | --- |
 * | one subtree | `paths.ts` — four addressable areas, containment after symlink resolution |
 * | never outside it | `paths.ts` + `session.ts` — refuses, never clamps |
 * | never delete | there is no delete in this package, checked by `sourceRules.ts` |
 * | never modify an unmarked file | `frontmatter.ts`, checked against the bytes on disk |
 * | atomic | `session.ts` — temp file in the same directory, fsync, rename |
 * | not into an unmounted vault | `mount.ts` |
 * | bounded | `session.ts` — files per run and bytes per file |
 *
 * Start at `session.ts`; the other modules are its parts.
 *
 * ## The order below is the order the package is meant to be read in
 *
 * The safety layer first (`frontmatter`, `mount`, `paths`, `session`), then
 * the four note writers built on it, then `sync.ts` — the one composition that
 * turns them into a run.
 *
 * **Tasks 5–8 each shipped without their exports here** (M5 task 15). Four
 * complete, heavily-tested note writers, and the one door into the package
 * mentioned none of them — which is the same defect one level down from
 * "nothing calls them", and is why `tests/vault/wiring.test.ts` now asserts
 * that every module in this directory is re-exported here rather than trusting
 * the next person to remember.
 */

export {
  applyManagedBlock,
  hasManagedBlock,
  isWatchfloorManaged,
  renderManagedNote,
  splitManagedBlock,
  VaultContentError,
  WATCHFLOOR_BEGIN_MARKER,
  WATCHFLOOR_END_MARKER,
  type ManagedBlockOptions,
  type ManagedContent,
  type ManagedNoteInput,
} from './frontmatter.ts';

export {
  assertVaultMounted,
  checkVaultMount,
  icloudPlaceholderFor,
  vaultRootFromEnv,
  VaultMountError,
  type VaultMounted,
  type VaultMountRefusal,
  type VaultMountStatus,
  // The refusal half of VaultMountStatus. Absent until M5 task 15 needed to
  // name it in a return type: a caller handed a `VaultMountStatus` cannot
  // describe the not-mounted branch without it, and would reach past this
  // barrel into ./mount.ts to do so.
  type VaultUnmounted,
} from './mount.ts';

export {
  isContainedIn,
  resolveVaultPath,
  vaultAreaOf,
  VAULT_AREAS,
  VaultPathError,
  type ResolvedVaultPath,
  type VaultArea,
  type VaultPath,
  type VaultPathRefusal,
  type VaultTier,
} from './paths.ts';

export {
  openVaultSession,
  DEFAULT_VAULT_CAPS,
  VAULT_TEMP_PREFIX,
  VaultCapError,
  VaultSession,
  VaultWriteError,
  type VaultCapKind,
  type VaultCaps,
  type VaultWriteRefusal,
  type VaultWriteResult,
  // Task 9's read and remove primitives. `readVaultText` needs a SECOND
  // resolver because `atomicWrite` names its temp files with a leading dot and
  // `resolveVaultPath` refuses every dot-prefixed segment — so the files
  // `prune` exists to find are exactly the ones the write path cannot express.
  readVaultText,
  removeVaultFile,
  scanVaultTree,
  VaultAccessError,
  VaultRemoveError,
  type VaultAccessRefusal,
  type VaultEntry,
  type VaultEntryKind,
  type VaultRemoveRefusal,
} from './session.ts';

// ---------------------------------------------------------------------------
// When a daemon writes each area (task 15). Pure: no clock, no filesystem.
// ---------------------------------------------------------------------------

export {
  advanceVaultSlots,
  dueVaultWork,
  localDayOf,
  localHourStamp,
  weeklyReleaseStamp,
  NO_VAULT_SLOTS,
  WEEKLY_RELEASE_HOUR,
  type VaultSyncDue,
  type VaultSyncSlots,
} from './cadence.ts';

// ---------------------------------------------------------------------------
// The note writers (tasks 5–8). Each reported the export line it needed; each
// is reproduced from that report rather than guessed.
// ---------------------------------------------------------------------------

export {
  buildDailyNote,
  dailyNoteInstant,
  writeDailyNote,
  DEFAULT_FLAGGED_LIMIT,
  DEFAULT_TOP_PER_BEAT,
  type BeatCoverage,
  type DailyBeatSection,
  type DailyEntry,
  type DailyNote,
  type DailyNoteDeps,
} from './daily.ts';

export {
  buildBlurbPrompt,
  classifyEvidence,
  estimateReadTime,
  isoWeekOf,
  renderWeeklyNote,
  selectWeeklyReading,
  syncWeeklyNote,
  validateBlurbText,
  weeklyNoteInstant,
  weeklyNoteRelPath,
  BLURB_NOVEL_WORDS_MIN,
  BLURB_QUESTIONS,
  BLURB_SYSTEM,
  BLURB_TASK_ID,
  BODY_WORDS_MIN,
  DEFAULT_WEEKLY_LIMIT,
  EXCERPT_NOVEL_WORDS_MIN,
  HEADLINE_ONLY_LIMIT,
  MAX_MATERIAL_CHARS,
  WEEKLY_READING_KINDS,
  WORDS_PER_MINUTE,
  WeeklyBlurbError,
  type BlurbEvidence,
  type BlurbOutcome,
  type BlurbPromptItem,
  type BlurbQuestion,
  type BlurbRejection,
  type BlurbValidation,
  type EvidenceInput,
  type EvidenceLevel,
  type IsoWeek,
  type ReadTimeEstimate,
  type WeeklyBlurbCounts,
  type WeeklyCandidate,
  type WeeklyEntry,
  type WeeklyExclusions,
  type WeeklyNoteInput,
  type WeeklySelection,
  type WeeklySelectionDeps,
  type WeeklySelectionOptions,
  type WeeklySyncDeps,
  type WeeklySyncOptions,
  type WeeklySyncResult,
} from './weekly.ts';

export {
  entityFileName,
  entityNoteRelPath,
  planEntityNotes,
  renderEntityBlock,
  syncEntityNotes,
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_RELATED,
  EntityNameError,
  type EntityItemRef,
  type EntityNameRefusal,
  type EntityNotePlan,
  type EntityPlan,
  type EntityPlanOptions,
  type EntitySkip,
  type EntitySkipReason,
  type EntitySyncOptions,
  type EntitySyncResult,
  type RelatedEntity,
} from './entities.ts';

// ---------------------------------------------------------------------------
// The run itself (task 15) — the composition tasks 5–8 each reported needing.
// ---------------------------------------------------------------------------

export {
  loadVaultSyncDeps,
  resolveVaultTarget,
  runVaultSync,
  type VaultAreaRefusal,
  type VaultSyncDeps,
  type VaultSyncDepsOptions,
  type VaultSyncReport,
  type VaultSyncWork,
  type VaultTarget,
} from './sync.ts';

// ---------------------------------------------------------------------------
// The audit and the one job allowed to remove anything (task 9).
//
// Added here by task 15 rather than by task 9 itself — `src/vault/index.ts`
// belonged to this task, and `tests/vault/wiring.test.ts` failed on the day
// `verify.ts` and `prune.ts` landed without an entry, which is the barrel rule
// doing its job on a sibling's change. Reproduced from their exported surface;
// if task 9's report names a different set, reconcile against it.
// ---------------------------------------------------------------------------

export {
  readSavedIndex,
  verifyVault,
  type SavedIndexEntry,
  type VaultFinding,
  type VaultFindingCode,
  type VaultFindingSeverity,
  type VaultVerifyOptions,
  type VaultVerifyReport,
} from './verify.ts';

export {
  pruneVault,
  DEFAULT_MAX_DELETIONS_PER_RUN,
  DEFAULT_MIN_TEMP_AGE_MS,
  type PruneCandidate,
  type PruneOptions,
  type PruneReason,
  type PruneResult,
  type PruneSkip,
  type PruneSkipReason,
} from './prune.ts';

export {
  promoteSavedItem,
  readSavedItem,
  renderSavedNote,
  savedNotePath,
  savedTitleSlug,
  SAVED_KEY_SUFFIX_LENGTH,
  SAVED_SLUG_FALLBACK,
  SAVED_SLUG_MAX_LENGTH,
  type SavedItem,
  type SavedPromotion,
} from './saved.ts';
