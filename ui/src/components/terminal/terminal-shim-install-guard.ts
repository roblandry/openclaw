/**
 * Page-global install-once guard, ported from the shipped shims'
 * `window[FLAG]` pattern (see e.g. `terminal-android-ime.ts`'s
 * `__openclawTerminalImeShimV4`). Using the exact same flag names as the
 * shipped home-ops shims -- not a fresh module-scoped boolean -- matters
 * during a migration window: if the home-ops initContainer's injected
 * `<script>` shim and this built-in port both load on the same page (e.g.
 * mid-rollout, or a stale cached `index.html`), they defer to whichever
 * claims the flag first, exactly like two copies of the original shim
 * would. A module-local boolean cannot see the other copy's install at
 * all, and would double-install: duplicate document-level listeners,
 * duplicate synthetic events, duplicate observers.
 */
export function claimInstallFlag(flagName: string): boolean {
  const w = window as unknown as Record<string, unknown>;
  if (w[flagName]) {
    return false;
  }
  w[flagName] = true;
  return true;
}

/** Test-only: clears a claimed flag so a fresh install can be simulated. */
export function releaseInstallFlagForTests(flagName: string): void {
  delete (window as unknown as Record<string, unknown>)[flagName];
}
