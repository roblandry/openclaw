/**
 * Page-global install-once guard, ported from the shipped shims'
 * `window[FLAG]` pattern (see e.g. `terminal-key-row.js`'s
 * `__openclawTerminalKeyRowV4`). Using the exact same flag name as the
 * shipped home-ops shim -- not a fresh module-scoped boolean -- matters
 * during a migration window: if the home-ops initContainer's injected
 * `<script>` shim and this built-in port both load on the same page (e.g.
 * mid-rollout, or a stale cached `index.html`), they defer to whichever
 * claims the flag first, exactly like two copies of the original shim
 * would. A module-local boolean cannot see the other copy's install at
 * all, and would double-install: duplicate overlays, listeners, and
 * MutationObservers.
 */
export function claimInstallFlag(flagName: string): boolean {
  const w = window as unknown as Record<string, unknown>;
  if (w[flagName]) {
    return false;
  }
  w[flagName] = true;
  return true;
}

/**
 * Read-only check, for shims (like terminal-key-row.js) whose shipped source
 * checks the flag BEFORE a device gate but only SETS it AFTER that gate
 * passes -- i.e. checking and claiming are not atomic. Use with
 * `setInstallFlag` instead of `claimInstallFlag` to preserve that ordering.
 */
export function isInstallFlagSet(flagName: string): boolean {
  return Boolean((window as unknown as Record<string, unknown>)[flagName]);
}

/** Companion to `isInstallFlagSet`: claims the flag unconditionally. */
export function setInstallFlag(flagName: string): void {
  (window as unknown as Record<string, unknown>)[flagName] = true;
}

/** Test-only: clears a claimed flag so a fresh install can be simulated. */
export function releaseInstallFlagForTests(flagName: string): void {
  delete (window as unknown as Record<string, unknown>)[flagName];
}
