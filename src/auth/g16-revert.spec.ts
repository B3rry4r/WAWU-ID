import { normalisePhone } from '../common/phone.util';
import { revertClashes } from './g16-revert';

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
