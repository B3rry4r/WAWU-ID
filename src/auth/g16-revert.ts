import { releasedPhoneFor } from './released-phone';

/**
 * The rules of `revert` in scripts/data/g16-duplicate-phones.mjs (BACKEND_GAPS
 * G-16, AUTH-05), kept here so they are compiled with the service and tested.
 * The script itself is run only by the owner.
 *
 * `apply` records every row it saw holding each number it touched (the
 * keeper, the rows it released and the rows it held because their phone is
 * their only way in). Putting a released row's old phone back is refused when
 * the number, in any spelling, is held by a row `apply` did not see with that
 * phone (an account made, or a phone changed, after `apply`), or when its
 * exact old text is taken by any row (the column is unique).
 */
export interface Release {
  user_id: string;
  old_phone: string;
}
export interface Member {
  user_id: string;
  phone: string;
}
export interface LiveRow {
  id: string;
  phone: string;
}

export function revertClashes(
  releases: Release[],
  members: Member[],
  live: LiveRow[],
  normalise: (phone: string) => string | null,
): Release[] {
  const restoring = new Set(releases.map((r) => r.user_id));
  const seen = new Set(members.map((m) => `${m.user_id} ${m.phone}`));
  return releases.filter((r) => {
    const number = normalise(r.old_phone);
    return live.some(
      (u) =>
        u.id !== r.user_id &&
        !restoring.has(u.id) &&
        (u.phone === r.old_phone ||
          (number !== null &&
            normalise(u.phone) === number &&
            !seen.has(`${u.id} ${u.phone}`))),
    );
  });
}

/**
 * Which of the rows `apply` released `revert` may put back (JOIN-03 round 4,
 * D6). A row goes back only while it still reads `released:<its id>`, the
 * marker `apply` wrote. A row that reads anything else has moved on since: the
 * Hub finalised its deletion (`deleted:<id>`, and its proved number cleared),
 * or a person gave it another number. Putting the old phone and the old proved
 * number back over that would return a deleted person's number to the
 * identity table, so such a row is left exactly as it is.
 *
 * `restore` is what `revert` writes; `left` is what it skips and says so. The
 * `UPDATE` in the script repeats the same test in its WHERE, so a row changed
 * between this read and that write is skipped as well.
 */
export function stillReleased<T extends { user_id: string }>(
  releases: T[],
  live: LiveRow[],
): { restore: T[]; left: T[] } {
  const phoneOf = new Map(live.map((u) => [u.id, u.phone]));
  const restore: T[] = [];
  const left: T[] = [];
  for (const r of releases) {
    if (phoneOf.get(r.user_id) === releasedPhoneFor(r.user_id)) {
      restore.push(r);
    } else {
      left.push(r);
    }
  }
  return { restore, left };
}
