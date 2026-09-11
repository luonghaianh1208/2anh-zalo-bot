import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeBridgeCommand } from './zalo-policy.js';

const publicAuth = {
  actorUid: 'member-1', actorRole: 'public', sourceThreadId: 'group-1', sourceThreadType: 1, confirmed: false,
};
const ownerAuth = {
  actorUid: 'owner-1', actorRole: 'owner', sourceThreadId: 'owner-1', sourceThreadType: 0, confirmed: false,
};
const policyOptions = { ownerUids: new Set(['owner-1']) };

test('public actor can send only to the active conversation', () => {
  assert.deepEqual(authorizeBridgeCommand({
    type: 'invoke', method: 'sendSticker', args: [{ id: '1' }, 'group-1', 1], auth: publicAuth,
  }, policyOptions), { allowed: true, role: 'public', code: 'allowed', category: 'send' });

  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'sendSticker', args: [{ id: '1' }, 'other-group', 1], auth: publicAuth,
  }, policyOptions).code, 'cross_thread_denied');
});

test('public actor cannot call an owner method', () => {
  const result = authorizeBridgeCommand({
    type: 'invoke', method: 'removeUserFromGroup', args: [['user-2'], 'group-1'], auth: publicAuth,
  }, policyOptions);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'owner_required');
});

test('claimed owner role cannot elevate a uid absent from the allowlist', () => {
  const result = authorizeBridgeCommand({
    type: 'invoke', method: 'getAllGroups', args: [],
    auth: { ...publicAuth, actorRole: 'owner' },
  }, policyOptions);
  assert.equal(result.allowed, false);
  assert.equal(result.role, 'public');
  assert.equal(result.code, 'owner_required');
});

test('uid chủ nhân mà adapter hạ xuống public thì sidecar không tự nâng lại', () => {
  const result = authorizeBridgeCommand({
    type: 'invoke', method: 'getAllGroups', args: [], auth: { ...ownerAuth, actorRole: 'public' },
  }, policyOptions);
  assert.equal(result.role, 'public');
  assert.equal(result.code, 'owner_required');
});

test('allowlisted owner can call owner read operations', () => {
  assert.deepEqual(authorizeBridgeCommand({
    type: 'invoke', method: 'getAllGroups', args: [], auth: ownerAuth,
  }, policyOptions), { allowed: true, role: 'owner', code: 'allowed', category: 'read' });
});

test('dangerous owner operation requires explicit confirmation', () => {
  const command = {
    type: 'invoke', method: 'removeUserFromGroup', args: [['user-2'], 'group-1'], auth: ownerAuth,
  };
  assert.equal(authorizeBridgeCommand(command, policyOptions).code, 'confirmation_required');
  assert.equal(authorizeBridgeCommand({
    ...command, auth: { ...ownerAuth, confirmed: true },
  }, policyOptions).allowed, true);
});

test('undo is owner-only, confirmed, and scoped to its declared destination', () => {
  const command = { type: 'undo', threadId: 'group-1', threadType: 1, auth: ownerAuth };
  assert.equal(authorizeBridgeCommand(command, policyOptions).code, 'confirmation_required');
  assert.deepEqual(authorizeBridgeCommand({
    ...command, auth: { ...ownerAuth, confirmed: true },
  }, policyOptions), { allowed: true, role: 'owner', code: 'allowed', category: 'undo' });
});

test('missing and malformed authorization fail closed', () => {
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'group-1', threadType: 1 }, policyOptions).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({
    type: 'send', threadId: 'group-1', threadType: 1,
    auth: { actorUid: '', sourceThreadId: 'group-1', sourceThreadType: 1 },
  }, policyOptions).code, 'auth_required');
});

test('system actor (cron, thông báo gateway) chỉ gửi được tới chủ nhân hoặc kênh nhà', () => {
  const system = { actorUid: '', actorRole: 'system', sourceThreadId: '', sourceThreadType: 0, confirmed: false };
  const options = { ownerUids: new Set(['owner-1']), homeChannel: 'group-home' };
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'owner-1', threadType: 0, auth: system }, options).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'group-home', threadType: 1, auth: system }, options).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'group-1', threadType: 1, auth: system }, options).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({ type: 'invoke', method: 'getAllGroups', args: [], auth: system }, options).allowed, false);
});

test('public group_members chỉ đọc được nhóm đang trò chuyện; tra hồ sơ theo ID là việc của chủ', () => {
  assert.equal(authorizeBridgeCommand({ type: 'group_members', threadId: 'group-1', threadType: 1, auth: publicAuth }, policyOptions).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'group_members', threadId: 'other', threadType: 1, auth: publicAuth }, policyOptions).code, 'cross_thread_denied');
  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'getGroupMembersInfo', args: [['u1']], auth: publicAuth,
  }, policyOptions).code, 'owner_required');
});

test('ping is the only command exempt from authorization', () => {
  assert.deepEqual(authorizeBridgeCommand({ type: 'ping' }, policyOptions), {
    allowed: true, role: 'system', code: 'allowed', category: 'health',
  });
});
