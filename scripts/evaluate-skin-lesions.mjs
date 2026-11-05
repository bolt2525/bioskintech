import { readFile } from 'node:fs/promises';
import { evaluateSkinLesions } from '../src/lab/faceSim/skinLesionEvaluation.ts';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Uso: npm run lab:skin-evaluate -- referencias.json predicciones.json');
  console.log('Local, sin fotos, red ni entrenamiento. Salida JSON por categoría; >70% observado no equivale a validación clínica.');
  console.log('Referencias: {version:1,trainingGroups:[],images:[{id:"img-1",group:"grupo-1",boxes:[{category:"acne",x:0.1,y:0.2,width:0.1,height:0.1}]}]}');
  console.log('Predicciones: {version:1,model:"modelo-version",images:[{id:"img-1",boxes:[{category:"acne",x:0.1,y:0.2,width:0.1,height:0.1,score:0.8}]}]}');
  console.log('Categorías: acne, spot, nevus, scar, melasma, pore, fine-wrinkle, coarse-wrinkle. IDs/grupos seudónimos; no nombres, fotos ni claves R2.');
} else if (args.length !== 2) {
  console.error('Indica referencias y predicciones. Consulta --help.');
  process.exitCode = 1;
} else {
  try {
    const text = await Promise.all(args.map(path => readFile(path, 'utf8')));
    let references, predictions;
    try { [references, predictions] = text.map(value => JSON.parse(value)); }
    catch { throw new Error('Los archivos deben contener JSON válido. No se imprimió su contenido.'); }
    console.log(JSON.stringify(evaluateSkinLesions(references, predictions), null, 2));
  } catch (error) {
    console.error('No se completó la evaluación.', error instanceof Error && !('code' in error) ? error.message : 'No se pudieron leer los archivos locales.');
    process.exitCode = 1;
  }
}
