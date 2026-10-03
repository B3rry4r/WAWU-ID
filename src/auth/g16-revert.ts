/**
 * The clash rule of `revert` in scripts/data/g16-duplicate-phones.mjs
 * (BACKEND_GAPS G-16, AUTH-05), kept here so it is compiled with the service
 * and tested. The script itself is run only by the owner.
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
