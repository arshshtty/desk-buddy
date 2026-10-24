/* Desk Buddy: AudioWorklet that copies the microphone to the main thread in ~43 ms blocks
   (2048 frames at 48 kHz), for the on-device Whisper engine. It outputs silence. */
class DeskBuddyCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take; i += take;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("deskbuddy-capture", DeskBuddyCapture);
