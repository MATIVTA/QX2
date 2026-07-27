/**
 * ============================================================================
 *  Sincroniza el Google Sheet de desafíos con el bot de Discord.
 *
 *  Cómo funciona:
 *  1. En el Sheet, pegas la imagen directo en la celda de la columna A
 *     (selecciona la celda y Ctrl+V, tal cual — no hace falta usar el menú
 *     Insertar), y escribes la letra correcta en la columna B.
 *  2. Apenas escribes en la columna B, este script se dispara solo:
 *     - Toma la imagen de esa fila (soporta tanto una imagen pegada dentro
 *       de la celda con Ctrl+V, como una imagen insertada "sobre las
 *       celdas" con el menú Insertar > Imagen, por si la prefieres así).
 *     - La sube directo a tu repositorio de Github (carpeta challenges/).
 *     - Agrega una fila nueva a queue.csv en el mismo repositorio, apuntando
 *       a esa imagen — sin que tengas que abrir Github para nada.
 *     - Marca la fila como "✅ Publicado" en la columna C.
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
  if (range.getColumn() !== COL_RESPUESTA) return; // solo reacciona si editaste la columna de respuesta

  procesarFila(sheet, range.getRow());
}

function procesarFila(sheet, row) {
  if (row === 1) return; // encabezado

  const respuesta = sheet.getRange(row, COL_RESPUESTA).getValue().toString().trim().toUpperCase();
  const estadoActual = sheet.getRange(row, COL_ESTADO).getValue().toString();

  if (!respuesta) return;
  if (estadoActual.indexOf('✅') === 0) return; // ya estaba publicada, no la duplica

  const imagen = buscarImagenEnFila(sheet, row);
  if (!imagen) {
    sheet.getRange(row, COL_ESTADO).setValue('⚠️ No encontré una imagen en esta fila (columna A)');
    return;
  }

  try {
    const blob = obtenerBlobDeImagen(imagen);
    const imageUrl = subirImagenAGithub(blob, row);
    agregarFilaAQueue(imageUrl, respuesta);
    sheet.getRange(row, COL_ESTADO).setValue('✅ Publicado');
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
  const valorCelda = sheet.getRange(row, 1).getValue();
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
 * que el bot pueda descargarla.
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
 * Agrega una fila nueva a queue.csv en Github con la URL de la imagen y la
 * respuesta correcta.
 */
function agregarFilaAQueue(imageUrl, respuesta) {
  const { token, repo, branch } = getConfig_();
  const path = 'queue.csv';
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;

  // 1) Leer el contenido actual del archivo (Github lo exige para poder editarlo)
  const getResponse = UrlFetchApp.fetch(apiUrl, {
    headers: { Authorization: 'token ' + token },
    muteHttpExceptions: true,
  });

  if (getResponse.getResponseCode() >= 300) {
    throw new Error('No pude leer queue.csv en Github: ' + getResponse.getContentText());
  }

  const fileData = JSON.parse(getResponse.getContentText());
  const currentContent = Utilities.newBlob(Utilities.base64Decode(fileData.content), 'text/csv').getDataAsString();

  // 2) Agregar la nueva fila al final
  const newContent = currentContent.replace(/\s*$/, '') + `\n${imageUrl},${respuesta}\n`;

  // 3) Subir el archivo actualizado
  const putResponse = UrlFetchApp.fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'put',
    headers: { Authorization: 'token ' + token },
    contentType: 'application/json',
    payload: JSON.stringify({
      message: 'Nuevo desafío agregado desde Google Sheets',
      content: Utilities.base64Encode(newContent),
      sha: fileData.sha,
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
