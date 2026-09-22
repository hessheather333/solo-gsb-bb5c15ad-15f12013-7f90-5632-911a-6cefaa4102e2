// 控制台交接集成测试：启动独立服务实例（短交接码 TTL），验证：
//  1. 非持有者不能生成交接码；持有者生成后收到 6 位码，其他控制台收到“有待接收交接”，投屏不收；
//  2. 错误码 / 非法格式 / 投屏连接 / 持有者本人提交均被拒绝，控制权不变；
//  3. 接收方提交正确码：服务端原子转移控制权，双方实时收到成功结果，
//     计时保持运行且剩余时间连续（不重置、不中断），快照 holderId 换绑；
//  4. 交接成功后旧码立即失效：重复提交被拒绝；旧持有者迟到的指令/心跳被拒绝且不改写状态；
//  5. 重新生成使旧码立即失效（旧码按错误码拒绝），新码可正常交接；
//  6. 持有者主动释放后，未使用的交接码一并作废；
//  7. 60 秒（测试中缩短）未使用自动过期：持有者收到 expired，之后再提交被拒绝；
//  8. 连续输错达到上限后进入冷却（HANDOVER_THROTTLED）。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_HANDOVER_PORT || 3599;
const URL = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  });
}
async function next(inbox, type, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type && (!pred || pred(m)));
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}
async function drain(inbox, ms = 250) {
  await sleep(ms);
  return inbox.splice(0);
}
const send = (c, obj) => c.ws.send(JSON.stringify(obj));
const clientId = async (c) => (await next(c.inbox, 'hello')).clientId;
// 生成一个与给定码不同的 6 位错误码
const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT), HANDOVER_TTL_MS: '1500' },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  console.log('1) 非持有者生成被拒绝；持有者生成成功，各方消息可见性正确');
  const con = await connect();
  const conId = await clientId(con);
  await next(con.inbox, 'snapshot');
  await next(con.inbox, 'handover_pending'); // 首包携带交接状态（此时无待接收）

  const other = await connect();
  const otherId = await clientId(other);
  await next(other.inbox, 'snapshot');

  const screen = await connect();
  await clientId(screen);
  await next(screen.inbox, 'snapshot');
  send(screen, { command: 'screen_register', screenId: 's-testhandover01', name: '交接测试屏' });
  await next(screen.inbox, 'screen_hello');

  send(other, { command: 'handover_create' });
  const notOwner = await next(other.inbox, 'error');
  ok('非持有者 handover_create 返回 NOT_CONTROLLER', notOwner.code === 'NOT_CONTROLLER', notOwner.code);

  send(con, { command: 'acquire' });
  await next(con.inbox, 'control', (m) => m.granted === true);

  // 先让计时跑起来，验证交接过程计时连续
  send(con, { command: 'reset', durationMs: 60000 });
  await next(con.inbox, 'snapshot', (m) => m.phase === 'idle');
  send(con, { command: 'start' });
  await next(con.inbox, 'snapshot', (m) => m.phase === 'running');

  await drain(screen.inbox, 100);
  send(con, { command: 'handover_create' });
  const created = await next(con.inbox, 'handover_created');
  ok('持有者收到 6 位交接码与有效期', /^\d{6}$/.test(created.code) && created.expiresInMs > 0,
    JSON.stringify(created));
  const pending = await next(other.inbox, 'handover_pending', (m) => m.active === true);
  ok('其他控制台实时看到“有待接收交接”（不含码）',
    pending.active === true && pending.expiresInMs > 0 && !('code' in pending),
    JSON.stringify(pending));
  const screenMsgs = await drain(screen.inbox, 300);
  ok('投屏不接收任何交接消息',
    !screenMsgs.some((m) => m.type.startsWith('handover')),
    JSON.stringify(screenMsgs.map((m) => m.type)));

  console.log('2) 非法格式 / 错误码 / 投屏提交均被拒绝，控制权不变');
  send(other, { command: 'handover_accept', code: '12' });
  const badFmt = await next(other.inbox, 'error');
  ok('非 6 位格式返回 BAD_HANDOVER', badFmt.code === 'BAD_HANDOVER', badFmt.code);

  send(other, { command: 'handover_accept', code: wrongCode(created.code) });
  const wrong = await next(other.inbox, 'error');
  ok('错误码返回 BAD_HANDOVER_CODE', wrong.code === 'BAD_HANDOVER_CODE', wrong.code);

  send(screen, { command: 'handover_accept', code: created.code });
  const screenTry = await next(screen.inbox, 'error');
  ok('投屏连接提交返回 BAD_HANDOVER', screenTry.code === 'BAD_HANDOVER', screenTry.code);

  send(con, { command: 'handover_accept', code: created.code });
  const selfTry = await next(con.inbox, 'error');
  ok('持有者本人提交返回 BAD_HANDOVER', selfTry.code === 'BAD_HANDOVER', selfTry.code);

  console.log('3) 正确码原子交接：双方实时收到结果，计时连续不中断');
  send(other, { command: 'handover_accept', code: created.code });
  const granted = await next(other.inbox, 'control', (m) => m.granted === true);
  ok('接收方获得控制权', granted.granted === true && granted.targetId === otherId);
  const success = await next(other.inbox, 'handover_result');
  ok('接收方实时收到交接成功结果', success.result === 'success', JSON.stringify(success));

  const lost = await next(con.inbox, 'control', (m) => m.granted === false);
  ok('旧持有者收到控制权转移通知 reason=handover',
    lost.granted === false && lost.reason === 'handover' && lost.holderId === otherId,
    JSON.stringify(lost));
  const transferred = await next(con.inbox, 'handover_result');
  ok('旧持有者实时收到已交接结果', transferred.result === 'transferred', JSON.stringify(transferred));

  const pendingOff = await next(con.inbox, 'handover_pending', (m) => m.active === false);
  ok('交接成功后广播“无待接收交接”（码已失效）', pendingOff.active === false);

  const snapAfter1 = await next(other.inbox, 'snapshot', (m) => m.holderId === otherId);
  ok('快照 holderId 换绑且计时仍在运行（未重置）',
    snapAfter1.phase === 'running' && snapAfter1.remainingMs < 60000,
    JSON.stringify({ phase: snapAfter1.phase, remainingMs: snapAfter1.remainingMs }));
  const snapAfter2 = await next(other.inbox, 'snapshot', (m) => m.holderId === otherId && m.phase === 'running');
  ok('剩余时间继续走时（交接不中断计时）', snapAfter2.remainingMs < snapAfter1.remainingMs,
    `${snapAfter1.remainingMs} -> ${snapAfter2.remainingMs}`);

  console.log('4) 旧码一次性：重复提交被拒；旧持有者迟到指令/心跳不改写状态');
  const third = await connect();
  await clientId(third);
  await next(third.inbox, 'snapshot');
  send(third, { command: 'handover_accept', code: created.code });
  const repeat = await next(third.inbox, 'error');
  ok('重复提交已使用的码返回 HANDOVER_INACTIVE', repeat.code === 'HANDOVER_INACTIVE', repeat.code);

  send(con, { command: 'pause' });
  const lateCmd = await next(con.inbox, 'error');
  ok('旧持有者迟到指令返回 NOT_CONTROLLER', lateCmd.code === 'NOT_CONTROLLER', lateCmd.code);
  send(con, { command: 'heartbeat' });
  const lateBeat = await next(con.inbox, 'error');
  ok('旧持有者迟到心跳返回 NOT_CONTROLLER', lateBeat.code === 'NOT_CONTROLLER', lateBeat.code);
  send(con, { command: 'acquire' });
  const reacquire = await next(con.inbox, 'control', (m) => m.granted === false);
  ok('旧持有者重新申请被拒绝（locked）', reacquire.reason === 'locked', JSON.stringify(reacquire));
  const snapStill = await next(third.inbox, 'snapshot', (m) => m.holderId === otherId);
  ok('状态未被旧持有者改写（仍运行中、持有者不变）',
    snapStill.phase === 'running' && snapStill.holderId === otherId);

  console.log('5) 重新生成使旧码立即失效，新码可交接');
  send(other, { command: 'handover_create' });
  const codeB1 = (await next(other.inbox, 'handover_created')).code;
  send(other, { command: 'handover_create' });
  const codeB2 = (await next(other.inbox, 'handover_created')).code;
  send(third, { command: 'handover_accept', code: codeB1 });
  const stale = await next(third.inbox, 'error');
  ok('作废旧码提交返回 BAD_HANDOVER_CODE', stale.code === 'BAD_HANDOVER_CODE', stale.code);
  send(third, { command: 'handover_accept', code: codeB2 });
  await next(third.inbox, 'control', (m) => m.granted === true);
  const okB = await next(third.inbox, 'handover_result');
  ok('新码交接成功', okB.result === 'success');
  await next(other.inbox, 'control', (m) => m.granted === false && m.reason === 'handover');

  console.log('6) 持有者主动释放后，未使用的交接码一并作废');
  send(third, { command: 'handover_create' });
  const codeC = (await next(third.inbox, 'handover_created')).code;
  send(third, { command: 'release' });
  await next(third.inbox, 'control', (m) => m.granted === false && m.reason === 'released');
  await next(con.inbox, 'handover_pending', (m) => m.active === false);
  send(con, { command: 'handover_accept', code: codeC });
  const afterRelease = await next(con.inbox, 'error');
  ok('释放后提交交接码返回 HANDOVER_INACTIVE', afterRelease.code === 'HANDOVER_INACTIVE', afterRelease.code);

  console.log('7) 超时未使用自动过期：持有者收到 expired，之后再提交被拒');
  send(con, { command: 'acquire' });
  await next(con.inbox, 'control', (m) => m.granted === true);
  send(con, { command: 'handover_create' });
  const codeD = (await next(con.inbox, 'handover_created')).code;
  const expired = await next(con.inbox, 'handover_result', (m) => m.result === 'expired', 4000);
  ok('持有者实时收到交接码过期通知', expired.result === 'expired');
  const expiredPending = await next(other.inbox, 'handover_pending', (m) => m.active === false);
  ok('过期后广播“无待接收交接”', expiredPending.active === false);
  send(other, { command: 'handover_accept', code: codeD });
  const afterExpire = await next(other.inbox, 'error');
  ok('过期后提交被拒绝', afterExpire.code === 'HANDOVER_INACTIVE' || afterExpire.code === 'HANDOVER_EXPIRED',
    afterExpire.code);

  console.log('8) 连续输错达到上限进入冷却');
  send(con, { command: 'handover_create' });
  const codeE = (await next(con.inbox, 'handover_created')).code;
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    send(third, { command: 'handover_accept', code: wrongCode(codeE) });
    lastErr = await next(third.inbox, 'error');
  }
  ok('前 5 次错误码均返回 BAD_HANDOVER_CODE', lastErr.code === 'BAD_HANDOVER_CODE', lastErr.code);
  send(third, { command: 'handover_accept', code: codeE });
  const throttled = await next(third.inbox, 'error');
  ok('达到上限后即使码正确也被冷却拒绝', throttled.code === 'HANDOVER_THROTTLED', throttled.code);

  con.ws.close();
  other.ws.close();
  third.ws.close();
  screen.ws.close();
  console.log(`\n控制台交接测试：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join('; '));
    process.exit(1);
  }
} catch (e) {
  console.error('  ✗', e.stack || e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
