/**
 * Keep Signal session key material out of stdout.
 *
 * libsignal, the Signal implementation Baileys uses for WhatsApp's end-to-end encryption, passes whole session
 * objects to console.info/console.warn whenever a session is opened, closed or pruned (session_record.js:
 * "Opening session:", "Closing session:", "Session already closed", "Removing old closed session:"). A session
 * object holds the private ratchet keys and the root key. The calls go straight to the console, bypassing Logger and
 * LOG_LEVEL, so every session change wrote key material to the container log.
 *
 * Installed once at startup: every console method replaces a Signal session argument with a placeholder and passes
 * everything else through unchanged. main.ts imports this right after instrumentSentry, so this wrapper sits outside
 * Sentry's console instrumentation and Sentry breadcrumbs only ever see the redacted arguments.
 */

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

export const REDACTED_SESSION = '[Signal session redacted]';

const INSTALLED = Symbol.for('evolution-api.redactConsole');

/** A libsignal SessionEntry, recognised by class name or, should the name be lost, by its shape. */
export function isSignalSession(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (value.constructor?.name === 'SessionEntry') return true;
  return '_chains' in value || ('currentRatchet' in value && 'indexInfo' in value);
}

export function redactConsoleArgs(args: unknown[]): unknown[] {
  if (!args.some(isSignalSession)) return args;
  return args.map((arg) => (isSignalSession(arg) ? REDACTED_SESSION : arg));
}

export function installConsoleRedaction(target: Console = console): void {
  const marked = target as Console & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return;

  for (const method of METHODS) {
    const original = target[method] as (...args: unknown[]) => void;
    target[method] = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, redactConsoleArgs(args));
    } as Console[typeof method];
  }

  marked[INSTALLED] = true;
}

installConsoleRedaction();
