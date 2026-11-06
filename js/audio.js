/**
 * audio.js — Web Audio beep.
 *
 * Android Chrome blocks audio until the user has interacted with the page,
 * so the AudioContext is created and resumed synchronously inside the
 * "Start Tracking" / "Test beep" click handler.
 */

export class Beeper {
  constructor() {
    this.ctx = null;
    this.supported = Boolean(window.AudioContext || window.webkitAudioContext);
    this.unlocked = false;
  }

  /**
   * Create + resume the AudioContext and play a silent buffer.
   * MUST be called synchronously from a user gesture handler.
   * @returns {Promise<boolean>} resolves true when audio is ready
   */
  unlock() {
    if (!this.supported) return Promise.resolve(false);

    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch (err) {
        console.error('AudioContext failed', err);
        return Promise.resolve(false);
      }
    }

    const resumePromise =
      this.ctx.state === 'suspended' ? this.ctx.resume().catch(() => {}) : Promise.resolve();

    // A one-frame silent buffer is what actually unlocks playback on
    // browsers that only release the audio pipeline after real output.
    try {
      const buffer = this.ctx.createBuffer(1, 1, 22050);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ctx.destination);
      source.start(0);
    } catch (err) {
      console.warn('Audio unlock buffer failed', err);
    }

    this.unlocked = true;

    return resumePromise.then(() => {
      this.unlocked = this.ctx.state === 'running';
      return this.unlocked;
    });
  }

  /** Resume the context if the browser suspended it (e.g. after a call). */
  async resume() {
    if (!this.ctx || this.ctx.state !== 'suspended') return this.ctx?.state === 'running';
    try {
      await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  /**
   * Play the alert.
   * @param {{pattern?: 'alert'|'test'}} [opts]
   * @returns {boolean} true when sound was actually scheduled
   */
  play(opts = {}) {
    if (!this.ctx) return false;

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const tones =
      opts.pattern === 'test'
        ? [[880, 0], [1174.66, 0.14]]
        : [[987.77, 0], [1318.51, 0.15], [987.77, 0.3], [1318.51, 0.45]];

    const t0 = this.ctx.currentTime + 0.02;
    const peak = opts.pattern === 'test' ? 0.25 : 0.4;
    const length = opts.pattern === 'test' ? 0.12 : 0.13;

    try {
      for (const [freq, offset] of tones) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0 + offset);

        gain.gain.setValueAtTime(0.0001, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(peak, t0 + offset + 0.015);
        gain.gain.setValueAtTime(peak, t0 + offset + length - 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + length);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + length + 0.02);
      }
      return true;
    } catch (err) {
      console.error('Beep failed', err);
      return false;
    }
  }
}

/**
 * Vibrate the device. Android Chrome supports the Vibration API.
 * @param {number|number[]} pattern
 * @returns {boolean}
 */
export function vibrate(pattern) {
  if (!('vibrate' in navigator)) return false;
  try {
    return navigator.vibrate(pattern);
  } catch {
    return false;
  }
}
