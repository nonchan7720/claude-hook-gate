declare module 'claude-code' {
  interface PluginState {
    'feedback-gate': {
      /**
       * classic.* の hook が一度でも走ったセッションの ID（= そのセッションでは組織管理のガードに classic.* が飛ばされていない）。
       * 今のセッション ID と同じときだけ印とみなす。
       */
      classicSeen: string
    }
  }
}
