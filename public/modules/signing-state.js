(function attachSigningStateMachine(root) {
  const transitions = Object.freeze({
    idle: Object.freeze({ start: 'confirming', reset: 'idle' }),
    confirming: Object.freeze({ confirmed: 'preparing', failed: 'failed' }),
    preparing: Object.freeze({ prepared: 'signing', failed: 'failed' }),
    signing: Object.freeze({ signed: 'completing', failed: 'failed' }),
    completing: Object.freeze({ completed: 'complete', failed: 'failed' }),
    complete: Object.freeze({ start: 'confirming', reset: 'idle' }),
    failed: Object.freeze({ start: 'confirming', reset: 'idle' }),
  });
  const activePhases = new Set(['confirming', 'preparing', 'signing', 'completing']);

  function createSigningStateMachine(onChange = () => {}) {
    let phase = 'idle';

    function can(event) {
      return Boolean(transitions[phase]?.[event]);
    }

    function transition(event) {
      const nextPhase = transitions[phase]?.[event];
      if (!nextPhase) throw new Error(`Signing transition ${phase} -> ${event} is not allowed`);
      const previousPhase = phase;
      phase = nextPhase;
      onChange(Object.freeze({ event, previousPhase, phase }));
      return phase;
    }

    return Object.freeze({
      can,
      get phase() { return phase; },
      get active() { return activePhases.has(phase); },
      transition,
    });
  }

  root.PdfSigningState = Object.freeze({ createSigningStateMachine });
}(window));
