import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchProfile, pickProfile } from './auth.js';

test('fetchProfile không mang số điện thoại của tài khoản bot ra ngoài', async () => {
  const profile = await fetchProfile({
    fetchAccountInfo: async () => ({
      profile: { userId: '123', displayName: 'Bot', avatar: 'a.jpg', phoneNumber: '0900000000' },
    }),
  });

  assert.deepEqual(profile, { user_id: '123', display_name: 'Bot', avatar: 'a.jpg' });
});

test('hồ sơ đọc từ phiên cũ trên đĩa cũng bị bỏ số điện thoại', () => {
  assert.deepEqual(
    pickProfile({ user_id: '123', display_name: 'Bot', avatar: '', phone: '0900000000' }),
    { user_id: '123', display_name: 'Bot', avatar: '' },
  );
  assert.equal(pickProfile(null), null);
});
