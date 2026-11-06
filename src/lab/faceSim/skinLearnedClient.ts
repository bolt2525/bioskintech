import type { SkinLearnedResult, SkinWorkerResponse } from './skinLearnedImage';

export class SkinLearnedClient {
  private worker: Worker;
  private reject?: (error: Error) => void;
  private closed = false;

  constructor() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
      throw new Error('Este navegador no admite el motor local. Usa una versión actual de Chrome, Edge, Firefox o Safari compatible con OffscreenCanvas.');
    }
    this.worker = new Worker(new URL('./skinLearned.worker.ts', import.meta.url), { type: 'module' });
  }

  analyze(image: ImageBitmap, onProgress: (message: string) => void): Promise<SkinLearnedResult> {
    if (this.closed || this.reject) {
      image.close();
      return Promise.reject(new Error('El motor no está disponible o ya está procesando una foto.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose(new Error('El motor no respondió en dos minutos. Reintenta el análisis.')), 120000);
      const finish = () => { clearTimeout(timer); this.reject = undefined; };
      this.reject = error => { finish(); reject(error); };
      this.worker.onerror = event => {
        event.preventDefault();
        finish();
        reject(new Error(event.message || 'No se pudo iniciar el motor local.'));
        this.dispose();
      };
      this.worker.onmessage = ({ data }: MessageEvent<SkinWorkerResponse>) => {
        if (this.closed) return;
        if (data.kind === 'progress') onProgress(data.message);
        else {
          finish();
          if (data.kind === 'result') resolve(data.result);
          else reject(new Error(data.message));
        }
      };
      try { this.worker.postMessage({ image }, [image]); }
      catch (error) { image.close(); finish(); reject(error); }
    });
  }

  dispose(error: Error = new DOMException('Análisis cancelado.', 'AbortError')) {
    this.closed = true;
    this.worker.terminate();
    this.reject?.(error);
    this.reject = undefined;
  }
}
