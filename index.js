require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  PollLayoutType,
  MessageType,
} = require('discord.js');

const QUEUE_PATH = path.join(__dirname, 'queue.csv');
const STATE_PATH = path.join(__dirname, 'state.json');

const ANSWER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F']; // soporta hasta 6 alternativas si algún día las necesitas

// ---------- utilidades de almacenamiento ----------

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// queue.csv tiene dos columnas: image,answer
// Ejemplo:
// image,answer
// challenges/2026-08-01.png,B
// challenges/2026-08-02.png,A
function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return [];

  const lines = fs
    .readFileSync(QUEUE_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  // la primera línea es el encabezado (image,answer) y se descarta
  const rows = lines.slice(1);

  return rows.map((line) => {
    const [image, answer] = line.split(',').map((cell) => cell.trim());
    return { image, answer: (answer || '').toUpperCase() };
  });
}

function saveQueue(queue) {
  const header = 'image,answer';
  const rows = queue.map((item) => `${item.image},${item.answer}`);
  fs.writeFileSync(QUEUE_PATH, [header, ...rows].join('\n') + '\n');
}

function loadState() {
  // state = { pending: { messageId, channelId, answer, alternativesCount } | null }
  return readJSON(STATE_PATH, { pending: null });
}

function saveState(state) {
  writeJSON(STATE_PATH, state);
}

// ---------- lógica principal ----------

async function revealPreviousAnswer(client, state) {
  if (!state.pending) return;

  const { channelId, messageId, answer } = state.pending;
  const channel = await client.channels.fetch(channelId);

  let pollMessage = null;
  try {
    pollMessage = await channel.messages.fetch(messageId);
  } catch (err) {
    console.warn(`No se encontró el mensaje de la encuesta (${messageId}), probablemente fue borrado. Se envía igual la respuesta.`);
  }

  if (pollMessage) {
    try {
      // Cerramos la encuesta nosotros mismos (si no se había cerrado ya sola)
      if (pollMessage.poll && !pollMessage.poll.resultsFinalized) {
        await pollMessage.poll.end();
      }

      // Discord genera un mensaje automático de tipo "PollResult" cuando la encuesta
      // termina. No se puede desactivar, pero sí borrarlo. Puede tardar bastante en
      // aparecer (no es instantáneo), así que reintentamos varias veces antes de
      // rendirnos, en vez de esperar una sola vez.
      let resultMessage = null;
      for (let intento = 0; intento < 10 && !resultMessage; intento++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const recentMessages = await channel.messages.fetch({ limit: 15 });
        resultMessage = recentMessages.find(
          (m) => m.type === MessageType.PollResult && m.reference?.messageId === messageId
        );
      }
      if (resultMessage) {
        await resultMessage.delete();
      } else {
        console.warn('No apareció el mensaje automático de resultado tras esperar; se continúa igual.');
      }
    } catch (err) {
      console.error('Error cerrando/limpiando la encuesta anterior (se envía la respuesta igual):', err);
    }
  }

  try {
    await channel.send(`📊 ¡La encuesta terminó! La alternativa correcta era **${answer}**.`);
  } catch (err) {
    console.error('No se pudo enviar el mensaje con la respuesta correcta:', err);
  }

  state.pending = null;
  saveState(state);
}

async function postNextChallenge(client) {
  const queue = loadQueue();
  const state = loadState();

  if (queue.length === 0) {
    console.log('La cola de desafíos (queue.csv) está vacía. No hay nada que publicar hoy.');
    return;
  }

  const next = queue.shift();
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);

  // Descargar la imagen desde su URL (ej: Imgur) para adjuntarla como archivo real,
  // no como embed — así se ve igual que si hubieras subido el archivo a mano.
  let attachment;
  try {
    const imageResponse = await fetch(next.image);
    if (!imageResponse.ok) throw new Error(`status ${imageResponse.status}`);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const extension = (next.image.split('.').pop() || 'png').split('?')[0];
    attachment = new AttachmentBuilder(imageBuffer, { name: `desafio.${extension}` });
  } catch (err) {
    console.error(`No se pudo descargar la imagen ${next.image}: ${err.message}. Se descarta este ítem.`);
    saveQueue(queue);
    return;
  }

  // 1) Publicar la imagen del problema
  await channel.send({ files: [attachment] });

  // 2) Publicar la encuesta nativa con alternativas genéricas A/B/C/D
  const durationHours = Number(process.env.POLL_DURATION_HOURS || 24);
  const pollMessage = await channel.send({
    poll: {
      question: { text: '¿Cuál es la alternativa correcta?' },
      answers: ANSWER_LABELS.slice(0, 4).map((label) => ({ text: label })),
      duration: durationHours,
      allowMultiselect: false,
      layoutType: PollLayoutType.Default,
    },
  });

  // 3) Crear un hilo enlazado a la encuesta para que la gente debata ahí
  const thread = await pollMessage.startThread({
    name: `Debate - Desafío del ${new Date().toLocaleDateString('es-CL')}`,
    autoArchiveDuration: 1440, // se archiva solo tras 24h sin actividad
    reason: 'Hilo de discusión del desafío diario',
  });

  // Al crear un hilo desde un mensaje, Discord manda un mensaje automático de tipo
  // "ThreadCreated" ("X ha creado un hilo...") en el canal. No se puede desactivar,
  // así que lo buscamos entre los mensajes recientes y lo borramos, igual que con
  // el mensaje de resultado de la encuesta.
  let threadCreatedMessage = null;
  for (let intento = 0; intento < 10 && !threadCreatedMessage; intento++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const recentMessages = await channel.messages.fetch({ limit: 15 });
    threadCreatedMessage = recentMessages.find(
      (m) => m.type === MessageType.ThreadCreated && m.id !== pollMessage.id
    );
  }
  if (threadCreatedMessage) {
    await threadCreatedMessage.delete();
  } else {
    console.warn('No apareció el mensaje automático de "hilo creado" tras esperar; se continúa igual.');
  }

  // 4) Guardar en el estado que esta encuesta queda pendiente de revelar
  state.pending = {
    messageId: pollMessage.id,
    channelId: channel.id,
    threadId: thread.id,
    answer: next.answer,
  };
  saveState(state);
  saveQueue(queue);

  console.log(`Desafío publicado (${next.image}). Respuesta correcta guardada: ${next.answer}`);
}

// ---------- arranque del bot: corre una sola vez y se cierra ----------
// El horario ya no lo controla este script, lo controla el "schedule" del
// workflow de GitHub Actions (ver .github/workflows/daily.yml).
// MODE=publish  -> publica el desafío del día + abre la encuesta
// MODE=reveal   -> solo anuncia la respuesta correcta de la encuesta pendiente

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);

  const mode = (process.env.MODE || 'publish').toLowerCase();

  try {
    if (mode === 'reveal') {
      const state = loadState();
      await revealPreviousAnswer(client, state);
    } else {
      await postNextChallenge(client);
    }
    console.log(`Modo "${mode}" completado con éxito.`);
  } catch (err) {
    console.error(`Error en modo "${mode}":`, err);
    process.exitCode = 1;
  } finally {
    client.destroy();
    process.exit(process.exitCode ?? 0);
  }
});

client.login(process.env.DISCORD_TOKEN);
