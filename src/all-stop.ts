// Stop hook: 後続コマンド（followup）の実行待ち → gate の checks フェーズ → feedback ルールの stop_check → 完了通知、の順に実行する。
import { feedbackStopCheck } from './feedback-stop-check.ts'
import { followupStopCheck } from './followup.ts'
import type { Io, ScriptResult } from './io.ts'
import { notification } from './notification.ts'
import type { Dict } from './pyutil.ts'
import { stopTestGate } from './stop-test-gate.ts'

export async function allStop(io: Io, payload: Dict): Promise<ScriptResult> {
  let stdout = ''
  let stderr = ''
  let reportConsumed = false
  // 1 つでも止めたらそこで終了し、通知は出さない。まだ実行されていない後続コマンドがあれば、gate を走らせる前にそれを求める。
  for (const step of [() => followupStopCheck(io, payload), () => stopTestGate(io, 'checks', payload), () => feedbackStopCheck(io, payload)]) {
    const r = await step()
    stdout += r.stdout
    stderr += r.stderr
    if (r.exitCode !== 0) return { exitCode: r.exitCode, stdout, stderr }
    if (r.reportConsumed) reportConsumed = true
  }

  // stop_hook_active は Stop hook のブロックで会話が継続している状態を指す。
  // ここで通知すると「Stop hook feedback」のたびに鳴るため除外する。
  // ただし成功報告のブロックは通知なしで返しているので、その直後の Stop（gate が印を消費して通した回）だけは完了として通知する
  if (payload.stop_hook_active !== true || reportConsumed) {
    const r = await notification(io, 'stop', payload)
    stdout += r.stdout
    stderr += r.stderr
  }
  return { exitCode: 0, stdout, stderr }
}
