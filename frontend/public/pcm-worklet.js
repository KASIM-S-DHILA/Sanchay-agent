// AudioWorklet processor — captures Float32 mic input, converts to Int16 PCM,
// posts raw ArrayBuffers (~100ms chunks at 16kHz) to the main thread.
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._samplesNeeded = (sampleRate / 16000) * 128 * 4; // ~32ms worth
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this._buffer.push(pcm);

    const totalSamples = this._buffer.reduce((sum, b) => sum + b.length, 0);
    if (totalSamples >= this._samplesNeeded) {
      const merged = new Int16Array(totalSamples);
      let offset = 0;
      for (const chunk of this._buffer) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this._buffer = [];
      this.port.postMessage(merged.buffer, [merged.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-capture", PCMCaptureProcessor);
