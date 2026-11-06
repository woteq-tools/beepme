/**
 * wakeLock.js — keeps the screen on while tracking.
 *
 * The Screen Wake Lock API releases the lock whenever the page becomes
 * hidden, so it must be re-acquired on every `visibilitychange` to visible.
 */

export class WakeKeeper {
  constructor() {
    this.supported = 'wakeLock' in navigator;
    this.sentinel = null;
    this.desired = false;
    this.onchange = null;
  }

  /** @returns {Promise<boolean>} true if a lock is held afterwards */
  async request() {
    this.desired = true;
    if (!this.supported) return false;
    try {
      if (this.sentinel && !this.sentinel.released) return true;
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
        if (this.onchange) this.onchange(false);
      });
      if (this.onchange) this.onchange(true);
      return true;
    } catch (err) {
      console.warn('Wake lock request failed', err);
      return false;
    }
  }

  async release() {
    this.desired = false;
    try {
      if (this.sentinel && !this.sentinel.released) await this.sentinel.release();
    } catch (err) {
      console.warn('Wake lock release failed', err);
    }
    this.sentinel = null;
    if (this.onchange) this.onchange(false);
  }

  /** Re-acquire the lock if the page came back to the foreground. */
  async revalidate() {
    if (!this.desired) return false;
    if (document.visibilityState !== 'visible') return false;
    if (this.sentinel && !this.sentinel.released) return true;
    return this.request();
  }

  get active() {
    return Boolean(this.sentinel && !this.sentinel.released);
  }
}
