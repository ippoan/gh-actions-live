import type { Register } from 'claude-code'

import { register as registerPane } from './pane.tsx'
import { register as registerWatch } from './register.ts'

/**
 * hooks.json の `modules` は 1 plugin に 1 つだけ (2 つ目は plugin validate が拒否する)。
 * bridge の /watch に Monitor で繋ぐ register.ts と、右側パネルの pane.tsx をここで束ねる
 */
export const register: Register = (on, options) => {
  registerWatch(on, options)
  registerPane(on, options)
}
