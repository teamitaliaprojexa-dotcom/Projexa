// Processo separato (Web Worker) del recap nel browser: il modello WebLLM lavora qui, non
// nella pagina, così la dashboard resta utilizzabile durante il recap. La pagina lo comanda
// con CreateWebWorkerMLCEngine (vedi browser-recap.js) e lo chiude a recap finito.
import { WebWorkerMLCEngineHandler } from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
