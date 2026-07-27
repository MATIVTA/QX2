# Discord Daily Challenge Bot

Tu única tarea diaria es: abrir un Google Sheet, insertar la imagen del desafío en una celda,
y escribir la letra correcta al lado. **Todo lo demás pasa solo:** la imagen se sube a Imgur,
se agrega al repositorio de Github, y un bot la publica en Discord con una encuesta nativa
A/B/C/D — y al cerrar la encuesta, anuncia la respuesta correcta.

No necesitas abrir Github, no necesitas un servidor prendido 24/7.

## Cómo funciona (la cadena completa)

1. **Tú:** en el Google Sheet, insertas la imagen en la columna A y la respuesta en la columna B.
2. **Apps Script** (vive dentro del Sheet): al detectar que escribiste la respuesta, toma la
   imagen de esa fila y la sube directo a tu repositorio de Github (carpeta `challenges/`), y
   agrega una línea a `queue.csv` apuntando a esa imagen — sin que abras Github para nada.
3. **GitHub Actions:** todos los días a las 9:00am (hora Chile) enciende el bot, que toma la
   primera fila de `queue.csv`, descarga la imagen, la publica en Discord como archivo adjunto
   (no como link ni embed), y abre la encuesta nativa A/B/C/D (dura 12h).
4. A las 9:00pm (hora Chile), el bot se enciende de nuevo solo para anunciar la respuesta
   correcta de esa encuesta.

## Paso a paso completo

### 1. Crea el bot en Discord

1. Ve a https://discord.com/developers/applications → **New Application** → ponle un nombre.
2. Sección **Bot** → **Reset Token** → copia el token (es tu `DISCORD_TOKEN`, no lo compartas).
3. **OAuth2 → URL Generator**: marca `bot`, y en permisos: Ver canal, Enviar mensajes, Adjuntar
   archivos, Crear encuestas. Abre el link generado e invita el bot a tu servidor.
4. En Discord: Configuración → Avanzado → activa **Modo desarrollador**.
5. Click derecho en tu canal de desafíos → **Copiar ID de canal** (tu `CHANNEL_ID`).

### 2. Sube el código a Github

1. Crea un repositorio nuevo en https://github.com (puede ser privado).
2. Sube todos los archivos de este proyecto (**"Add file" → "Upload files"**), excepto `.env`.
3. Sube el workflow aparte para que no se pierda la carpeta oculta: **"Add file" → "Create new
   file"**, escribe el nombre `.github/workflows/daily.yml`, pega el contenido de ese archivo,
   y commitea.

### 3. Consigue un Personal Access Token de Github

Este token le da permiso al Apps Script para escribir en tu repositorio (tanto para subir las
imágenes como para actualizar `queue.csv`).

1. Ve a https://github.com/settings/tokens → **"Generate new token" → "Generate new token
   (classic)"**.
2. Dale un nombre, marca el scope **`repo`** completo (necesario para poder editar archivos).
3. Genera y copia el token — Github solo te lo muestra una vez.

### 4. Configura los Secrets del repositorio (para el bot)

**Settings → Secrets and variables → Actions → New repository secret**, crea:
- `DISCORD_TOKEN`
- `CHANNEL_ID`

### 5. Crea el Google Sheet

1. Crea una hoja nueva en https://sheets.google.com
2. Renombra la pestaña (abajo) a exactamente `Desafios`.
3. En la fila 1, pon encabezados: `A1 = Imagen`, `B1 = Respuesta`, `C1 = Estado`.

### 6. Agrega el Apps Script

1. En el Sheet: **Extensiones → Apps Script**.
2. Borra el código de ejemplo que trae por defecto, y pega todo el contenido del archivo
   `apps-script.gs` de este proyecto.
3. Arriba a la izquierda, en el ícono de engranaje **("Configuración del proyecto")** → baja
   hasta **"Propiedades del script"** → agrega estas 3 propiedades:
   - `GITHUB_TOKEN` → el que sacaste en el paso 3.
   - `GITHUB_REPO` → escrito así: `tu-usuario/nombre-del-repo` (ej: `juanperez/discord-daily-challenge`).
   - `GITHUB_BRANCH` → `main` (o el nombre de tu rama principal si es distinto).
4. Guarda el proyecto (ícono de disquete).

### 7. Activa el trigger automático

Esto es lo que hace que el script se dispare solo cada vez que edites el Sheet — sin este paso,
el código está ahí pero no reacciona a nada.

1. En Apps Script, ícono del **reloj** (Activadores/Triggers) en el menú izquierdo.
2. **"+ Agregar activador"**.
3. Función a ejecutar: `alEditar`. Fuente del evento: **"Desde la hoja de cálculo"**.
   Tipo de evento: **"Al editar"**. Guardar.
4. Te va a pedir autorizar permisos (acceso a la hoja y a servicios externos) — es normal,
   acepta con tu cuenta de Google.

### 8. Úsalo

1. En la fila 2 del Sheet: click en la celda **A2** y pega la imagen con **Ctrl+V** — directo,
   tal cual la copiaste (de internet, de un recorte de pantalla, de donde sea). No necesitas
   pasar por ningún menú.
2. En B2, escribe la letra correcta (ej: `C`).
3. Apenas confirmes esa celda, el script corre solo: toma la imagen pegada, la sube a Github y
   agrega la fila a `queue.csv`. En la columna C vas a ver **"✅ Publicado"** (o un mensaje de
   error si algo falló, para que sepas qué corregir).
4. Repite con cada fila nueva para tus próximos desafíos.

Si algo no se disparó solo (por ejemplo si pegaste la respuesta sin "confirmarla" con Enter/Tab),
usa el menú que aparece en el Sheet: **"Desafío diario" → "🧪 Probar fila actual"**, parado en
la fila que quieras forzar.

### 9. Pruébalo manualmente (sin esperar al cron)

En tu repo de Github: pestaña **Actions** → workflow "Publicar desafío diario" → **Run
workflow** → elige `publish` (para probar que publica) o `reveal` (para probar que anuncia la
respuesta).

## Ajustar horarios

El bot corre a las 9:00am (publica) y 9:00pm (revela), hora de Chile continental. Si necesitas
otra hora, edita `.github/workflows/daily.yml` — Github usa **hora UTC**, no tu hora local.
Recuerda que Chile cambia de horario el 5 de septiembre de 2026 (pasa a UTC-3): ese día hay que
restarle 1 hora a ambos crons.

## Notas y límites a tener en cuenta

- Las imágenes quedan guardadas dentro de tu propio repositorio (carpeta `challenges/`), servidas
  vía `raw.githubusercontent.com` — no dependes de ningún servicio externo de hosting de imágenes.
- Si `queue.csv` se queda sin filas, el workflow corre igual pero no publica nada.
- `state.json` lo actualiza y commitea el propio workflow — no lo edites a mano.
- El estado "✅ Publicado" en el Sheet evita que la misma fila se vuelva a subir dos veces si
  editas la columna B por error.
