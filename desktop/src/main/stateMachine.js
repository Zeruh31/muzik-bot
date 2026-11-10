'use strict';

// Lifecycle of one managed process (Lavalink or the bot).
//
//   stopped ──start──▶ starting ──ready──▶ ready
//      ▲                  │  │                │
//      │                  │  └─────exit/fail──┼──▶ error ──start──▶ starting
//      │                stop                stop     │
//      │                  ▼                   ▼      └─retry──▶ restarting ──start──▶ starting
//      └─────exit──── stopping ◀──────────────┘                     │
//                                                                  stop ──▶ stopped

const STATES = Object.freeze(['stopped', 'starting', 'ready', 'stopping', 'error', 'restarting']);

const TRANSITIONS = Object.freeze({
  stopped: { start: 'starting', stop: 'stopped' },
  starting: { ready: 'ready', stop: 'stopping', exit: 'error', fail: 'error' },
  ready: { stop: 'stopping', exit: 'error', fail: 'error' },
  stopping: { exit: 'stopped', stop: 'stopping' },
  error: { start: 'starting', retry: 'restarting', stop: 'stopped' },
  restarting: { start: 'starting', stop: 'stopped' },
});

class TransitionError extends Error {
  constructor(state, event) {
    super(`Geçersiz durum geçişi: ${state} + ${event}`);
    this.name = 'TransitionError';
    this.state = state;
    this.event = event;
  }
}

/** Returns the next state, or null when the event is not allowed in this state. */
function nextState(state, event) {
  return TRANSITIONS[state]?.[event] ?? null;
}

/** Like nextState, but throws for a transition that is not allowed. */
function transition(state, event) {
  const next = nextState(state, event);
  if (!next) throw new TransitionError(state, event);
  return next;
}

/** True while a process exists or is about to (used to decide whether "start" is a no-op). */
function isActive(state) {
  return state === 'starting' || state === 'ready' || state === 'stopping';
}

module.exports = { STATES, TRANSITIONS, nextState, transition, isActive, TransitionError };
