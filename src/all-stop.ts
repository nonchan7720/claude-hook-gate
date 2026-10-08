// Stop hook: gate の checks フェーズ → feedback ルールの stop_check → 完了通知、の順に実行する。
import { feedbackStopCheck } from './feedback-stop-check.ts'
import type { Io, ScriptResult } from './io.ts'
import { notification } from './notification.ts'
import type { Dict } from './pyutil.ts'
import { stopTestGate } from './stop-test-gate.ts'

export async function allStop(io: Io, payload: Dict): Promise<ScriptResult> {
  let stdout = ''
  let stderr = ''
  let reportConsumed = false
  // gate が 1 つでも止めたらそこで終了し、通知は出さない
  for (const step of [() => stopTestGate(io, 'checks', payload), () => feedbackStopCheck(io, payload)]) {
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
