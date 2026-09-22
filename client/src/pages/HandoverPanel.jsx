import { useEffect, useRef, useState } from 'react';
import { monoNow } from '../time.js';

const CODE_LEN = 6;
const FLASH_MS = 8000;      // 交接结果横幅展示时长
const ERROR_CODES = new Set([
  'BAD_HANDOVER', 'BAD_HANDOVER_CODE', 'HANDOVER_INACTIVE',
  'HANDOVER_EXPIRED', 'HANDOVER_THROTTLED',
]);

const RESULT_TEXT = {
  transferred: '✅ 控制权已交接给新控制台，本端转为旁观',
  success: '✅ 交接成功，你已接管控制权',
  expired: '⏱ 交接码已过期，可重新生成',
};

// 剩余秒数：以收到服务端消息时的本地单调时钟为锚倒计时（仅用于展示，权威判定在服务端）
function remainSeconds(info) {
  if (!info) return 0;
  return Math.max(0, Math.ceil((info.expiresInMs - (monoNow() - info.receivedAtMono)) / 1000));
}

// 交接结果横幅（等待/成功/过期双方实时可见），8 秒后自动消失
function HandoverFlash({ result }) {
  const [flash, setFlash] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    if (!result) return undefined;
    setFlash(result);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer.current);
  }, [result]);
  if (!flash || !RESULT_TEXT[flash.result]) return null;
  const cls = flash.result === 'expired' ? 'handover-flash handover-flash-expired' : 'handover-flash handover-flash-ok';
  return <div className={cls}>{RESULT_TEXT[flash.result]}</div>;
}

// 交接相关服务端错误展示 5 秒
function HandoverError({ lastError, onClearError }) {
  const show = lastError && ERROR_CODES.has(lastError.code);
  useEffect(() => {
    if (!show || !onClearError) return undefined;
    const t = setTimeout(onClearError, 5000);
    return () => clearTimeout(t);
  }, [show, onClearError]);
  if (!show) return null;
  return <p className="agenda-error">⚠ {lastError.message}</p>;
}

// 控制台交接（持有者侧）：
//  - 生成 60 秒有效的一次性交接码，口头/即时消息告知接收方即可；
//  - 生成后自己仍持有控制权，可照常操作计时/议程/巡检/提示；
//  - 接收方提交正确码后，服务端原子转移控制权：计时、议程、巡检与提示状态连续，投屏不中断；
//  - 码在交接成功或 60 秒超时后立即失效；重新生成会使旧码立即失效。
export default function HandoverPanel({ handoverCode, handoverPending, handoverResult, lastError, onClearError, onCreate }) {
  const remain = remainSeconds(handoverCode);
  return (
    <fieldset className="panel handover-panel">
      <legend>控制台交接（生成 60 秒一次性交接码，接收方凭码无缝接管控制权）</legend>

      <HandoverFlash result={handoverResult} />

      {handoverCode ? (
        <div className="handover-active">
          <div className="handover-code-row">
            <span className="handover-code-label">交接码</span>
            <span className="handover-code">{handoverCode.code}</span>
            <span className={`handover-countdown ${remain <= 10 ? 'handover-countdown-urgent' : ''}`}>
              {remain}s
            </span>
          </div>
          <p className="hint">
            等待接收方输入…交接成功后控制权立即转移；{remain > 0 ? `${remain} 秒后` : ''}未使用将自动过期。
            重新生成会使当前码立即失效。
          </p>
          <button type="button" className="btn btn-mini" onClick={onCreate}>↻ 重新生成交接码</button>
        </div>
      ) : (
        <div className="handover-idle">
          <button type="button" className="btn btn-primary" onClick={onCreate}>生成交接码</button>
          <p className="hint">
            生成后你仍可正常操作；接收方在另一台设备打开 /console 输入该码，
            服务端原子转移控制权，计时/议程/巡检/提示与投屏画面均不中断。码 60 秒内有效，一次性使用。
          </p>
        </div>
      )}

      {handoverPending && !handoverCode && (
        <p className="hint">当前有待接收的交接（剩余约 {remainSeconds(handoverPending)} 秒）。</p>
      )}

      <HandoverError lastError={lastError} onClearError={onClearError} />
    </fieldset>
  );
}

// 控制台交接（接收方侧，渲染在锁定面板内）：
// 持有者告知 6 位交接码后，在此输入并接管；成功/失败结果实时反馈。
export function HandoverAccept({ handoverPending, handoverResult, lastError, onClearError, onAccept }) {
  const [code, setCode] = useState('');

  const submit = () => {
    const trimmed = code.trim();
    if (trimmed.length !== CODE_LEN) return;
    onAccept(trimmed);
    setCode('');
  };

  return (
    <div className="handover-accept">
      <HandoverFlash result={handoverResult} />
      <div className="handover-accept-row">
        <input
          className="handover-input"
          value={code}
          inputMode="numeric"
          autoComplete="off"
          maxLength={CODE_LEN}
          placeholder="6 位交接码"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LEN))}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={code.trim().length !== CODE_LEN}
          onClick={submit}
        >
          凭码接管控制权
        </button>
      </div>
      <p className="hint">
        {handoverPending
          ? `持有方已生成交接码（剩余约 ${remainSeconds(handoverPending)} 秒），请向其索取后输入。`
          : '如持有方提供了交接码，可在此输入立即接管；接管后计时与投屏保持连续。'}
      </p>
      <HandoverError lastError={lastError} onClearError={onClearError} />
    </div>
  );
}
