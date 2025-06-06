require("dotenv").config();
const { Client, LocalAuth, MessageMedia, List } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const creds = require("./credentials.json");

const client = new Client({
  puppeteer: { headless: true, args: ["--no-sandbox"] },
  authStrategy: new LocalAuth({ clientId: "bot-inventory" }),
  webVersionCache: {
    type: "remote",
    remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2411.2.html",
  },
  authTimeoutMs: 60000,
  qrTimeout: 30000,
});

const conversationStates = {};
const userData = {};

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () => console.log("Client is ready!"));
client.on("authenticated", () => console.log("Client is authenticated!"));
client.on("auth_failure", (msg) => console.error("Authentication failure", msg));

// JWT Auth
function getServiceAccountAuth() {
  return new JWT({
    email: creds.client_email,
    key: creds.private_key.replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
}

// Cargar info de Google Sheets
async function getSheetInfo() {
  const serviceAccountAuth = getServiceAccountAuth();
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

// Formatea el precio con $ y puntos
function formatPrice(price) {
  if (!price) return "";
  let num = price.toString().replace(/\D/g, "");
  if (!num) return "";
  return "$ " + Number(num).toLocaleString("es-CO");
}

// Reinicia la conversación
function resetConversation(from) {
  conversationStates[from] = null;
  userData[from] = {};
}

// Manejo de mensajes
client.on("message", async (msg) => {
  const from = msg.from;
  const body = msg.body.trim();

  // Solo responde si inicia con @lista o si ya está en conversación
  if (!conversationStates[from] && !body.toLowerCase().includes("@lista")) return;

  try {
    // INICIO
    if (!conversationStates[from] || conversationStates[from] === "ended") {
      if (!body.toLowerCase().includes("@lista")) return;
      resetConversation(from);
      conversationStates[from] = "marcas";
      const fecha = new Date();
      const fechaStr = `${fecha.getDate().toString().padStart(2, "0")}/${(fecha.getMonth() + 1).toString().padStart(2, "0")}/${fecha.getFullYear()}`;
      await client.sendMessage(from, `¡Hola! 👋\nEsta es la lista actualizada *${fechaStr}*.\n¿Sobre qué marca quieres saber?`);
      // Cargar marcas (nombres de hojas)
      const doc = await getSheetInfo();
      const marcas = doc.sheetsByIndex.map(s => s.title);
      userData[from] = { marcas };
      let opciones = marcas.map((m, i) => `*${i + 1}.* ${m}`).join("\n");
      opciones += `\n\n*0.* Cancelar`;
      await client.sendMessage(from, opciones);
      return;
    }

    // SELECCIÓN DE MARCA
    if (conversationStates[from] === "marcas") {
      if (body === "0") {
        await client.sendMessage(from, "Conversación reiniciada. Escribe @lista para empezar de nuevo.");
        resetConversation(from);
        conversationStates[from] = "ended";
        return;
      }
      const idx = parseInt(body) - 1;
      const marcas = userData[from].marcas;
      if (isNaN(idx) || idx < 0 || idx >= marcas.length) {
        await client.sendMessage(from, "Opción inválida. Por favor selecciona una marca válida.");
        return;
      }
      const marca = marcas[idx];
      userData[from].marca = marca;
      // Cargar categorías de la hoja seleccionada
      const doc = await getSheetInfo();
      const sheet = doc.sheetsByTitle[marca];
      const rows = await sheet.getRows();
      // Extraer categorías únicas
      const categoriasSet = new Set();
      rows.forEach(row => {
        if (row._rawData[0]) categoriasSet.add(row._rawData[0].toString().trim());
      });
      const categorias = Array.from(categoriasSet);
      if (categorias.length === 0) {
        await client.sendMessage(from, "No hay categorías disponibles para esta marca.");
        resetConversation(from);
        conversationStates[from] = "ended";
        return;
      }
      userData[from].categorias = categorias;
      conversationStates[from] = "categorias";
      let opciones = categorias.map((c, i) => `*${i + 1}.* ${c}`).join("\n");
      opciones += `\n\n*0.* Volver a marcas`;
      await client.sendMessage(from, `Selecciona una categoría para *${marca}*:\n${opciones}`);
      return;
    }

    // SELECCIÓN DE CATEGORÍA
    if (conversationStates[from] === "categorias") {
      if (body === "0") {
        conversationStates[from] = "marcas";
        // Volver a mostrar marcas
        const marcas = userData[from].marcas;
        let opciones = marcas.map((m, i) => `*${i + 1}.* ${m}`).join("\n");
        opciones += `\n\n*0.* Cancelar`;
        await client.sendMessage(from, `¿Sobre qué marca quieres saber?\n${opciones}`);
        return;
      }
      const idx = parseInt(body) - 1;
      const categorias = userData[from].categorias;
      if (isNaN(idx) || idx < 0 || idx >= categorias.length) {
        await client.sendMessage(from, "Opción inválida. Por favor selecciona una categoría válida.");
        return;
      }
      const categoria = categorias[idx];
      userData[from].categoria = categoria;
      // Cargar productos de la categoría seleccionada
      const doc = await getSheetInfo();
      const sheet = doc.sheetsByTitle[userData[from].marca];
      const rows = await sheet.getRows();
      // Filtrar productos por categoría
      const productos = rows.filter(row => (row._rawData[0] || "").toString().trim() === categoria);
      if (productos.length === 0) {
        await client.sendMessage(from, "No hay productos disponibles en esta categoría.");
        conversationStates[from] = "categorias";
        return;
      }
      // Mostrar productos en formato lista
      let lista = productos.map(row => {
        const nombre = row._rawData[1] ? row._rawData[1].toString().trim() : "";
        const variante = row._rawData[2] ? row._rawData[2].toString().trim() : "";
        const precio = formatPrice(row._rawData[row._rawData.length - 1]);
        return `*${nombre}${variante ? ' ' + variante : ''}*\n${precio}`;
      }).join("\n\n");
      lista += `\n\n*0.* Volver\n*9.* Cerrar conversación`;
      await client.sendMessage(from, `*${categoria} disponibles:*\n\n${lista}`);
      conversationStates[from] = "final";
      return;
    }

    // FINAL: opción para volver o cerrar conversación
    if (conversationStates[from] === "final") {
      if (body === "0") {
        // Volver a categorías
        conversationStates[from] = "categorias";
        const categorias = userData[from].categorias;
        let opciones = categorias.map((c, i) => `*${i + 1}.* ${c}`).join("\n");
        opciones += `\n\n*0.* Volver a marcas`;
        await client.sendMessage(from, `Selecciona una categoría para *${userData[from].marca}*:\n${opciones}`);
        return;
      } else if (body === "9") {
        await client.sendMessage(from, "Conversación cerrada. Escribe @lista para empezar de nuevo.");
        resetConversation(from);
        conversationStates[from] = "ended";
        return;
      } else {
        await client.sendMessage(from, "Escribe *0* para volver o *9* para cerrar la conversación.");
        return;
      }
    }

  } catch (error) {
    console.error("Error en el flujo:", error);
    await client.sendMessage(from, "Ocurrió un error inesperado. Intenta de nuevo más tarde.");
    resetConversation(from);
    conversationStates[from] = "ended";
  }
});

client
  .initialize()
  .then(() => console.log("Client initialized successfully"))
  .catch((err) => console.error("Error initializing client", err));