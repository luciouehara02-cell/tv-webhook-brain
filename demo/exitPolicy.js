export function shouldExitPosition(state, exitSignal) {
  if (!state.position.inPosition) {
    return {
      allowed: false,
      reasons: ["not in position"],
    };
  }

  if (!exitSignal || !exitSignal.shouldExit) {
    return {
      allowed: false,
      reasons: ["no exit trigger"],
    };
  }

  return {
    allowed: true,
    reasons: [],
  };
}
