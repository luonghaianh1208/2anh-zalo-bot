const PUBLIC_READ_METHODS = new Set([
  'searchSticker', 'getStickersDetail', 'getListReminder',
]);

// getGroupMembersInfo tra hồ sơ theo ID thành viên bất kỳ, không gắn với
// nhóm nào — người ngoài xem thành viên nhóm mình qua lệnh group_members.
const OWNER_READ_METHODS = new Set([
  'getGroupMembersInfo',
  'getGroupChatHistory', 'getGroupInfo', 'getAllGroups', 'getAllFriends',
  'getUserInfo', 'findUser', 'findUserByUsername', 'fetchAccountInfo',
  'getPollDetail', 'getPendingGroupMembers', 'getGroupLinkDetail',
]);

const PUBLIC_SIDE_EFFECT_METHODS = new Set([
  'sendMessage', 'sendVoice', 'sendSticker', 'sendLink', 'uploadAttachment',
  'createReminder', 'removeReminder',
]);

const OWNER_SIDE_EFFECT_METHODS = new Set([
  'forwardMessage', 'createPoll', 'lockPoll', 'createNote',
  'setPinnedConversations', 'setMute', 'changeGroupName', 'addUserToGroup',
  'removeUserFromGroup', 'addGroupDeputy', 'removeGroupDeputy',
  'reviewPendingMemberRequest', 'enableGroupLink', 'disableGroupLink',
  'createGroup', 'inviteUserToGroups', 'joinGroupLink', 'updateProfileBio',
  'updateActiveStatus',
]);

const DANGEROUS_METHODS = new Set([
  'lockPoll', 'setPinnedConversations', 'setMute', 'changeGroupName',
  'addUserToGroup', 'removeUserFromGroup', 'addGroupDeputy', 'removeGroupDeputy',
  'reviewPendingMemberRequest', 'enableGroupLink', 'disableGroupLink',
  'createGroup', 'inviteUserToGroups', 'joinGroupLink', 'updateProfileBio',
  'updateActiveStatus',
]);

const PUBLIC_COMMANDS = new Set(['send', 'typing', 'reaction', 'seen', 'ack_message']);

const TARGET_ARG_INDEX = new Map([
  ['sendMessage', 1], ['sendVoice', 1], ['sendSticker', 1], ['sendLink', 1],
  ['uploadAttachment', 1], ['createReminder', 1], ['getListReminder', 0],
  ['removeReminder', 1],
]);

function denied(role, code, category) {
  return { allowed: false, role, code, category };
}

function allowed(role, category) {
  return { allowed: true, role, code: 'allowed', category };
}

function sameThread(command, auth) {
  let targetId = command.threadId;
  let targetType = command.threadType;
  if (command.type === 'invoke') {
    const index = TARGET_ARG_INDEX.get(String(command.method || ''));
    if (index == null) return true;
    targetId = Array.isArray(command.args) ? command.args[index] : null;
    if (['getListReminder'].includes(command.method)) targetType = command.args?.[1];
    else targetType = command.args?.[index + 1];
  }
  return String(targetId ?? '') === String(auth.sourceThreadId ?? '')
    && Number(targetType) === Number(auth.sourceThreadType);
}

function classify(command) {
  if (command.type === 'ping') return { minimumRole: 'system', category: 'health', dangerous: false };
  if (PUBLIC_COMMANDS.has(command.type)) return { minimumRole: 'public', category: 'send', dangerous: false };
  if (command.type === 'group_members') return { minimumRole: 'public', category: 'read', dangerous: false };
  if (command.type === 'history') return { minimumRole: 'public', category: 'read', dangerous: false };
  if (command.type === 'undo') return { minimumRole: 'owner', category: 'undo', dangerous: true };
  if (command.type !== 'invoke') return null;

  const method = String(command.method || '');
  if (PUBLIC_READ_METHODS.has(method)) return { minimumRole: 'public', category: 'read', dangerous: false };
  if (OWNER_READ_METHODS.has(method)) return { minimumRole: 'owner', category: 'read', dangerous: false };
  if (PUBLIC_SIDE_EFFECT_METHODS.has(method)) return { minimumRole: 'public', category: 'send', dangerous: false };
  if (OWNER_SIDE_EFFECT_METHODS.has(method)) {
    return { minimumRole: 'owner', category: 'admin', dangerous: DANGEROUS_METHODS.has(method) };
  }
  return null;
}

export function authorizeBridgeCommand(command, { ownerUids = new Set() } = {}) {
  const rule = classify(command || {});
  if (!rule) return denied('public', 'command_denied', 'unknown');
  if (rule.minimumRole === 'system') return allowed('system', rule.category);

  const auth = command?.auth;
  const owners = ownerUids instanceof Set ? ownerUids : new Set(ownerUids || []);
  if (auth?.actorRole === 'system') {
    // Ngoài lượt chat (cron, gửi bù sau khi gateway khởi động lại, thông báo)
    // không có người gửi. Cầu nối chỉ nhận kết nối có token từ chính Hermes,
    // nên vai trò này tới được mọi hội thoại — nhưng chỉ để gửi chữ hoặc báo
    // đang gõ, không gọi hàm Zalo, không đọc lịch sử, không thu hồi.
    return ['send', 'typing'].includes(command.type)
      ? allowed('system', rule.category)
      : denied('system', 'auth_required', rule.category);
  }
  if (!auth || !String(auth.actorUid || '') || !String(auth.sourceThreadId || '')
      || ![0, 1].includes(Number(auth.sourceThreadType))) {
    return denied('public', 'auth_required', rule.category);
  }

  // Phải vừa nằm trong allowlist vừa được adapter xác nhận là chủ của lượt này:
  // adapter có thể hạ một lượt của chủ xuống quyền công khai (xem
  // _bind_turn_for_source), sidecar không được tự nâng lại.
  const role = owners.has(String(auth.actorUid)) && auth.actorRole === 'owner' ? 'owner' : 'public';
  if (rule.minimumRole === 'owner' && role !== 'owner') {
    return denied(role, 'owner_required', rule.category);
  }
  if (role === 'public' && !sameThread(command, auth)) {
    return denied(role, 'cross_thread_denied', rule.category);
  }
  if (rule.dangerous && auth.confirmed !== true) {
    return denied(role, 'confirmation_required', rule.category);
  }
  return allowed(role, rule.category);
}

export const ZALO_POLICY_METHODS = Object.freeze({
  publicRead: PUBLIC_READ_METHODS,
  ownerRead: OWNER_READ_METHODS,
  publicSideEffects: PUBLIC_SIDE_EFFECT_METHODS,
  ownerSideEffects: OWNER_SIDE_EFFECT_METHODS,
  dangerous: DANGEROUS_METHODS,
});
