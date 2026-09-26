// Cattura audio della registrazione riunioni su un thread audio dedicato (AudioWorklet),
// non sul thread principale. Così, anche quando la CPU è impegnata (es. trascrizione nel
// browser), non si perdono pezzi di audio come accadeva col vecchio ScriptProcessorNode.
//
// Riceve un ingresso a 2 canali (0 = microfono, 1 = audio di sistema), ridimensiona a
// 16 kHz mediando i campioni (con riporto frazionario, così non c'è deriva nel tempo) e
// invia al thread principale blocchi Int16 dei due canali. Il main thread li accoda e li
// invia/trascrive: se è momentaneamente occupato, i messaggi restano in coda, niente perdite.
class RecProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = (options && options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / target; // sampleRate = frequenza del contesto audio (globale nel worklet)
    this.phase = 0;
    this.sumM = 0; this.sumS = 0; this.n = 0;
    this.bufM = []; this.bufS = [];
    this.flushEvery = Math.max(1, Math.round(target / 4)); // invia ~4 volte al secondo
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const m = input[0] || null;         // canale microfono
    const s = input[1] || input[0] || null; // canale audio di sistema (o mic se manca)
    const frames = (m || s) ? (m || s).length : 0;
    for (let i = 0; i < frames; i++) {
      this.sumM += m ? m[i] : 0;
      this.sumS += s ? s[i] : 0;
      this.n += 1;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const aM = this.sumM / this.n, aS = this.sumS / this.n;
        this.bufM.push(aM < 0 ? Math.max(-32768, aM * 32768) : Math.min(32767, aM * 32767));
        this.bufS.push(aS < 0 ? Math.max(-32768, aS * 32768) : Math.min(32767, aS * 32767));
        this.sumM = 0; this.sumS = 0; this.n = 0;
      }
    }
    if (this.bufM.length >= this.flushEvery) {
      this.port.postMessage({ mic: Int16Array.from(this.bufM), sys: Int16Array.from(this.bufS) });
      this.bufM = []; this.bufS = [];
    }
    return true; // continua a girare finché il nodo è connesso
  }
}

registerProcessor('rec-processor', RecProcessor);
