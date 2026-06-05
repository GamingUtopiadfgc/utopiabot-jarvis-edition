'use strict';

// Mic capture shared by the main HUD and the Settings window. Records from the
// microphone via MediaRecorder, then decodes + downmixes + resamples to a
// 16 kHz mono PCM16 WAV (what Whisper expects) and returns it as base64.
// Exposed as window.AudioCapture.
(function () {
  // Encode mono Float32 samples to a 16-bit PCM WAV (ArrayBuffer).
  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return buffer;
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // Decode a recorded blob to a 16 kHz mono WAV (base64, no data-url prefix).
  async function blobToWavBase64(blob, targetRate = 16000) {
    const arrayBuf = await blob.arrayBuffer();
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuf);
    } finally {
      decodeCtx.close();
    }
    const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, frames, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return bufToBase64(encodeWav(rendered.getChannelData(0), targetRate));
  }

  // A simple mic recorder. Open with a deviceId, expose the live stream so the
  // caller can drive a visualizer, then stop() to get the WAV.
  class Recorder {
    constructor() {
      this.stream = null;
      this.recorder = null;
      this.chunks = [];
    }

    async start(deviceId) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      this.chunks = [];
      this.recorder = new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      this.recorder.start();
      return this.stream;
    }

    // Stop recording; resolves with the 16 kHz mono WAV as base64.
    stop() {
      return new Promise((resolve, reject) => {
        if (!this.recorder) return resolve('');
        this.recorder.onstop = async () => {
          try {
            const blob = new Blob(this.chunks, {
              type: this.recorder.mimeType || 'audio/webm',
            });
            const b64 = blob.size ? await blobToWavBase64(blob) : '';
            resolve(b64);
          } catch (err) {
            reject(err);
          } finally {
            this._closeStream();
          }
        };
        try {
          this.recorder.stop();
        } catch (err) {
          this._closeStream();
          reject(err);
        }
      });
    }

    _closeStream() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      this.recorder = null;
    }
  }

  window.AudioCapture = { Recorder, blobToWavBase64 };
})();
