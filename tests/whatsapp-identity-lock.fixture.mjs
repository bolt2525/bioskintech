// Offline contract double for the identity wrapper supplied by the parallel task.
// --import this file before loading WA modules; never opens a database connection.
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';

const context = new AsyncLocalStorage();
let readers = 0;
let writerPending = false;
let changed = [];
const wake = () => { const waiting = changed; changed = []; waiting.forEach(resolve => resolve()); };
const wait = () => new Promise(resolve => changed.push(resolve));

export const identityLockHeld = () => context.getStore() === true;
export const identityReaderCount = () => readers;

export async function withIdentityReadLock(operation) {
  if (identityLockHeld()) return operation();
  while (writerPending) await wait();
  readers++;
  try { return await context.run(true, operation); }
  finally { readers--; wake(); }
}

export function releaseTestIdentities(operation) {
  // Simulate the separate purge request, not a forbidden same-session lock upgrade.
  return context.exit(async () => {
    writerPending = true;
    try {
      while (readers) await wait();
      return await operation();
    } finally { writerPending = false; wake(); }
  });
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/identity-reservations.js') || specifier === './identity-reservations.js')
      return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
