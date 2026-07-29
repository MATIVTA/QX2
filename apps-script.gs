/**
 * ============================================================================
 *  Sincroniza el Google Sheet de desafíos con el bot de Discord.
 *
 *  Cómo funciona:
 *  1. En el Sheet, pegas la imagen directo en la celda de la columna A
 *     (selecciona la celda y Ctrl+V, tal cual — no hace falta usar el menú
 *     Insertar), y escribes la letra correcta en la columna B.
 *  2. Apenas escribes en la columna A o B, este script se dispara solo:
 *     - Toma la imagen de esa fila (soporta tanto una imagen pegada dentro
 *       de la celda con Ctrl+V, como una imagen insertada "sobre las
 *       celdas" con el menú Insertar > Imagen, por si la prefieres así).
 *     - La sube directo a tu repositorio de Github (carpeta challenges/).
 *     - Agrega o ACTUALIZA la fila correspondiente en queue.csv, según si
 *       esa fila del Sheet ya estaba publicada antes o no.
 *     - Marca la fila como "✅ Publicado" (nueva) o "✅ Actualizado" (edición)
 *       en la columna C.
 *  3. Si BORRAS la imagen y la respuesta de una fila que ya estaba
 *     publicada, el script la QUITA de queue.csv (siempre que todavía no
 *     le haya tocado el turno al bot) y deja el Estado vacío de nuevo.
 *
 *  IMPORTANTE: todo esto solo afecta a queue.csv (la cola de espera). Si un
 *  desafío YA salió publicado en Discord, editar o borrar la fila del Sheet
 *  no cambia lo que ya está en Discord — eso hay que editarlo/borrarlo a
 *  mano ahí.
 *
 *  CONFIGURACIÓN REQUERIDA (una sola vez):
 *  Extensiones > Apps Script > ícono de engranaje (Configuración del proyecto)
 *  > Propiedades del script > agrega estas 3:
 *    - GITHUB_TOKEN      -> un Personal Access Token de Github (ver README)
 *    - GITHUB_REPO       -> "tu-usuario/discord-daily-challenge"
 *    - GITHUB_BRANCH     -> "main" (o el nombre de tu rama principal)
 *
 *  Luego debes crear el "trigger instalable" (ver README, paso a paso) para
 *  que este script se ejecute automáticamente al editar el Sheet.
 * ============================================================================
 */

const SHEET_NAME = 'Desafios'; // debe coincidir EXACTO con el nombre de tu hoja
const COL_IMAGEN = 1; // columna A
const COL_RESPUESTA = 2; // columna B
const COL_ESTADO = 3; // columna C

/**
 * Esta es la función que debes conectar al trigger instalable "onEdit".
 * NO la ejecutes manualmente para probar completo (necesita un "edit" real);
 * usa el menú "🧪 Probar fila actual" que se agrega solo en el Sheet.
 */
function alEditar(e) {
  const range = e.range;
  const sheet = range.getSheet();

  if (sheet.getName() !== SHEET_NAME) return;

  // Reacciona tanto si cambias la imagen (columna A) como la respuesta (B),
  // así una edición posterior también se propaga.
  const columna = range.getColumn();
  if (columna !== COL_IMAGEN && columna !== COL_RESPUESTA) return;

  procesarFila(sheet, range.getRow());
}

function procesarFila(sheet, row) {
  if (row === 1) return; // encabezado

  const respuesta = sheet.getRange(row, COL_RESPUESTA).getValue().toString().trim().toUpperCase();
  const imagen = buscarImagenEnFila(sheet, row);
  const marcador = `desafio-${row}-`;

  // La fuente de verdad de si esta fila "ya estaba publicada" es queue.csv
  // en Github, NO la columna Estado del Sheet — así funciona bien aunque
  // borres la columna Estado sin querer al limpiar una fila.
  let lineas, sha, indiceExistente;
  try {
    const queueActual = leerQueue_();
    lineas = queueActual.lineas;
    sha = queueActual.sha;
    indiceExistente = lineas.findIndex(function (linea, idx) {
      return idx > 0 && linea.indexOf(marcador) !== -1;
    });
  } catch (err) {
    sheet.getRange(row, COL_ESTADO).setValue('❌ Error leyendo la cola: ' + err.message);
    return;
  }
  const yaEstabaEnQueue = indiceExistente !== -1;

  // Caso: no hay ni imagen ni respuesta -> si seguía en la cola, la sacamos
  if (!imagen && !respuesta) {
    if (yaEstabaEnQueue) {
      const nuevasLineas = lineas.filter(function (_, idx) { return idx !== indiceExistente; });
      try {
        guardarQueue_(nuevasLineas, sha, `Quita el desafío de la fila ${row} (borrado desde Google Sheets)`);
      } catch (err) {
        sheet.getRange(row, COL_ESTADO).setValue('❌ Error al quitar de la cola: ' + err.message);
        return;
      }
    }
    sheet.getRange(row, COL_ESTADO).setValue('');
    return;
  }

  if (!respuesta) return; // todavía falta la respuesta, espera a que la escribas

  if (!imagen) {
    sheet.getRange(row, COL_ESTADO).setValue('⚠️ No encontré una imagen en esta fila (columna A)');
    return;
  }

  try {
    const blob = obtenerBlobDeImagen(imagen);
    const imageUrl = subirImagenAGithub(blob, row);

    let nuevasLineas;
    if (yaEstabaEnQueue) {
      nuevasLineas = lineas.slice();
      nuevasLineas[indiceExistente] = `${imageUrl},${respuesta}`;
      guardarQueue_(nuevasLineas, sha, `Actualiza el desafío de la fila ${row} desde Google Sheets`);
      sheet.getRange(row, COL_ESTADO).setValue('✅ Actualizado');
    } else {
      nuevasLineas = lineas.concat([`${imageUrl},${respuesta}`]);
      guardarQueue_(nuevasLineas, sha, 'Nuevo desafío agregado desde Google Sheets');
      sheet.getRange(row, COL_ESTADO).setValue('✅ Publicado');
    }
  } catch (err) {
    sheet.getRange(row, COL_ESTADO).setValue('❌ Error: ' + err.message);
  }
}

/**
 * Busca la imagen de la fila, soportando dos formas de haberla puesto ahí:
 *  a) Pegada directo en la celda A con Ctrl+V (queda como un valor tipo
 *     "CellImage" dentro de la celda).
 *  b) Insertada "sobre las celdas" con el menú Insertar > Imagen (queda
 *     como una imagen flotante, ancla en alguna celda de la fila).
 */
function buscarImagenEnFila(sheet, row) {
  // a) Imagen pegada dentro de la celda A (Ctrl+V)
  const valorCelda = sheet.getRange(row, COL_IMAGEN).getValue();
  if (valorCelda && typeof valorCelda.getContentUrl === 'function') {
    return { tipo: 'celda', contentUrl: valorCelda.getContentUrl() };
  }

  // b) Imagen flotante insertada con el menú Insertar > Imagen > Sobre las celdas
  const imagenes = sheet.getImages();
  for (const img of imagenes) {
    if (img.getAnchorCell().getRow() === row) {
      return { tipo: 'flotante', blob: img.getBlob() };
    }
  }

  return null;
}

/**
 * Convierte lo que encontró buscarImagenEnFila() en un Blob real, sin
 * importar si la imagen estaba pegada en la celda o flotante.
 */
function obtenerBlobDeImagen(imagen) {
  if (imagen.tipo === 'celda') {
    const response = UrlFetchApp.fetch(imagen.contentUrl, { muteHttpExceptions: true });
    if (response.getResponseCode() >= 300) {
      throw new Error('No pude descargar la imagen pegada en la celda (código ' + response.getResponseCode() + ')');
    }
    return response.getBlob();
  }
  return imagen.blob;
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');
  const branch = props.getProperty('GITHUB_BRANCH') || 'main';
  if (!token || !repo) throw new Error('Falta configurar GITHUB_TOKEN o GITHUB_REPO en Propiedades del script');
  return { token, repo, branch };
}

function extensionParaTipo_(contentType) {
  const mapa = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  return mapa[contentType] || 'png';
}

/**
 * Sube el blob de la imagen directo al repositorio de Github, dentro de
 * challenges/, y devuelve la URL pública (raw.githubusercontent.com) para
 * que el bot pueda descargarla. El nombre de archivo incluye el número de
 * fila (desafio-<fila>-<timestamp>) para poder encontrar/actualizar/borrar
 * la línea correspondiente en queue.csv más adelante.
 */
function subirImagenAGithub(blob, row) {
  const { token, repo, branch } = getConfig_();
  const extension = extensionParaTipo_(blob.getContentType());
  const nombreArchivo = `desafio-${row}-${Date.now()}.${extension}`;
  const path = `challenges/${nombreArchivo}`;

  const response = UrlFetchApp.fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'put',
    headers: { Authorization: 'token ' + token },
    contentType: 'application/json',
    payload: JSON.stringify({
      message: `Sube imagen del desafío (fila ${row})`,
      content: Utilities.base64Encode(blob.getBytes()),
      branch: branch,
    }),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 300) {
    throw new Error('No pude subir la imagen a Github: ' + response.getContentText());
  }

  return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

/**
 * Lee el queue.csv actual desde Github. Devuelve las líneas ya separadas
 * (incluyendo el encabezado en el índice 0) más el sha del archivo, que
 * Github exige para poder editarlo.
 */
function leerQueue_() {
  const { token, repo, branch } = getConfig_();
  const path = 'queue.csv';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;

  const getResponse = UrlFetchApp.fetch(apiUrl, {
    headers: { Authorization: 'token ' + token },
    muteHttpExceptions: true,
  });

  if (getResponse.getResponseCode() >= 300) {
    throw new Error('No pude leer queue.csv en Github: ' + getResponse.getContentText());
  }

  const fileData = JSON.parse(getResponse.getContentText());
  const contenido = Utilities.newBlob(Utilities.base64Decode(fileData.content), 'text/csv').getDataAsString();
  const lineas = contenido.split('\n').filter(function (l) { return l.trim() !== ''; });

  return { lineas: lineas, sha: fileData.sha };
}

/**
 * Sube un queue.csv nuevo a Github, reemplazando el contenido completo.
 */
function guardarQueue_(lineas, sha, mensaje) {
  const { token, repo, branch } = getConfig_();
  const path = 'queue.csv';
  const nuevoContenido = lineas.join('\n') + '\n';

  const putResponse = UrlFetchApp.fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'put',
    headers: { Authorization: 'token ' + token },
    contentType: 'application/json',
    payload: JSON.stringify({
      message: mensaje,
      content: Utilities.base64Encode(nuevoContenido),
      sha: sha,
      branch: branch,
    }),
    muteHttpExceptions: true,
  });

  if (putResponse.getResponseCode() >= 300) {
    throw new Error('No pude guardar en Github: ' + putResponse.getContentText());
  }
}

/**
 * Agrega un menú al Sheet para poder probar manualmente la fila donde
 * tengas el cursor, sin tener que re-escribir la respuesta para disparar
 * el trigger de nuevo.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Desafío diario')
    .addItem('🧪 Probar fila actual', 'probarFilaActual')
    .addToUi();
}

function probarFilaActual() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const row = sheet.getActiveCell().getRow();
  procesarFila(sheet, row);
  SpreadsheetApp.getUi().alert('Listo, revisa la columna "Estado" de la fila ' + row);
}
