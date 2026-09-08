import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setupBotListener } from './bot-handler.js';

test('listener cleanup detaches handlers and stops exactly once', () => {
  class Listener extends EventEmitter {
    starts = 0;
    stops = 0;
    start() { this.starts += 1; }
    stop() { this.stops += 1; }
  }
  const listener = new Listener();
  const cleanup = setupBotListener({ listener }, { user_id: 'bot' });
  assert.equal(listener.starts, 1);
  assert.equal(listener.listenerCount('message'), 1);
  assert.equal(listener.listenerCount('error'), 1);
  cleanup();
  cleanup();
  assert.equal(listener.stops, 1);
  assert.equal(listener.listenerCount('message'), 0);
  assert.equal(listener.listenerCount('error'), 0);
});

