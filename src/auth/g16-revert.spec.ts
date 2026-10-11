import { normalisePhone } from '../common/phone.util';
import { revertClashes, stillReleased } from './g16-revert';

/** G-16 (AUTH-05 fix round 2, D2): what blocks putting a released phone back. */
describe('revertClashes', () => {
  // apply's view of one set: keeper k (0803...), released r (+234...), held
  // phone-only h (234...).
  const releases = [{ user_id: 'r', old_phone: '+2348031110005' }];
  const members = [
    { user_id: 'k', phone: '08031110005' },
    { user_id: 'r', phone: '+2348031110005' },
    { user_id: 'h', phone: '2348031110005' },
  ];
  const afterApply = [
    { id: 'k', phone: '08031110005' },
    { id: 'r', phone: 'released:r' },
    { id: 'h', phone: '2348031110005' },
  ];

  it('lets the rows apply kept or held stand: a set with a held phone-only row can be undone', () => {
    expect(
      revertClashes(releases, members, afterApply, normalisePhone),
    ).toEqual([]);
  });

  it('still refuses when a new row holds the number in any spelling', () => {
    for (const phone of ['0803 111 0005', '+2348031110005', '08031110005']) {
      expect(
        revertClashes(
          releases,
          members,
          [
            ...afterApply.filter((u) => u.phone !== phone),
            { id: 'new', phone },
          ],
          normalisePhone,
        ),
      ).toEqual(releases);
    }
  });

  it('refuses when a row apply saw now holds the number under another spelling it did not have', () => {
    const moved = afterApply.map((u) =>
      u.id === 'h' ? { ...u, phone: '+234 803 111 0005' } : u,
    );
    expect(revertClashes(releases, members, moved, normalisePhone)).toEqual(
      releases,
    );
  });
});

/**
 * G-16 revert (JOIN-03 round 4, D6): a row goes back only while it still reads
 * `released:<its id>`. The script's own run, against a database, is
 * test/g16-duplicate-phones.local.mjs.
 */
describe('stillReleased', () => {
  const releases = [
    {
      user_id: 'a',
      old_phone: '+2348031110001',
      old_verified_for: '+2348031110001',
    },
    { user_id: 'b', old_phone: '+2348031110002', old_verified_for: null },
    { user_id: 'c', old_phone: '+2348031110003', old_verified_for: null },
    { user_id: 'd', old_phone: '+2348031110004', old_verified_for: null },
  ];

  it('restores a row that still reads released:<its id>, with its fields as they were', () => {
    const live = [{ id: 'a', phone: 'released:a' }];
    expect(stillReleased(releases.slice(0, 1), live)).toEqual({
      restore: releases.slice(0, 1),
      left: [],
    });
  });

  it('leaves a row the Hub finalised as deleted (deleted:<id>), and says so', () => {
    const live = [{ id: 'a', phone: 'deleted:a' }];
    expect(stillReleased(releases.slice(0, 1), live)).toEqual({
      restore: [],
      left: releases.slice(0, 1),
    });
  });

  it("leaves a row that was given another number, and one whose released marker is another account's", () => {
    const live = [
      { id: 'b', phone: '+2348039990000' },
      { id: 'c', phone: 'released:b' },
    ];
    expect(stillReleased(releases.slice(1, 3), live).left).toEqual(
      releases.slice(1, 3),
    );
    expect(stillReleased(releases.slice(1, 3), live).restore).toEqual([]);
  });

  it('leaves a row that is no longer there', () => {
    expect(stillReleased(releases.slice(3), [])).toEqual({
      restore: [],
      left: releases.slice(3),
    });
  });

  it('splits a mixed set, each side in the order apply wrote it', () => {
    const live = [
      { id: 'a', phone: 'released:a' },
      { id: 'b', phone: 'deleted:b' },
      { id: 'c', phone: 'released:c' },
      { id: 'd', phone: '08031110004' },
    ];
    const { restore, left } = stillReleased(releases, live);
    expect(restore.map((r) => r.user_id)).toEqual(['a', 'c']);
    expect(left.map((r) => r.user_id)).toEqual(['b', 'd']);
  });
});
