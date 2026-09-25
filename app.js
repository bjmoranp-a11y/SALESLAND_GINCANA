/* Control de Asistencia — escaneo de QR y registro en Supabase
 * Cada QR debe contener un JSON con: DNI, ASISTENTE, COORDINADOR, CAMPANA
 */

const TABLE = "asistencia";
const QUEUE_KEY = "asistencia_pending_queue_v1";
const OPERATOR_KEY = "asistencia_operador_v1";
const SCAN_COOLDOWN_MS = 3000; // evita registrar el mismo QR varias veces seguidas

const sb = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);

const el = {
  // Pop-up de login
  loginModal: document.getElementById("login-modal"),
  loginNombre: document.getElementById("login-nombre"),
  loginDni: document.getElementById("login-dni"),
  loginError: document.getElementById("login-error"),
  btnLogin: document.getElementById("btn-login"),

  // Barra superior y operador
  operatorBar: document.getElementById("operator-bar"),
  operatorName: document.getElementById("operator-name"),
  mainContent: document.getElementById("main-content"),
  btnLogout: document.getElementById("btn-logout"),
  btnAttendance: document.getElementById("btn-attendance"),

  // Escaneo / resultado
  resultCard: document.getElementById("result-card"),
  resultIcon: document.getElementById("result-icon"),
  resultTitle: document.getElementById("result-title"),
  resultFields: document.getElementById("result-fields"),
  connStatus: document.getElementById("conn-status"),
  queueStatus: document.getElementById("queue-status"),
  historyList: document.getElementById("history-list"),
  btnToggleCamera: document.getElementById("btn-toggle-camera"),
  btnTorch: document.getElementById("btn-torch"),

  // Pop-up de asistentes registrados
  attendanceModal: document.getElementById("attendance-modal"),
  btnCloseAttendance: document.getElementById("btn-close-attendance"),
  attendanceSearch: document.getElementById("attendance-search"),
  attendanceList: document.getElementById("attendance-list"),
  attendanceEmpty: document.getElementById("attendance-empty"),
  attendanceLoading: document.getElementById("attendance-loading"),
};

let operador = null; // { nombre, dni }

// ---------- Login / identificación del operador ----------

function loadOperador() {
  try {
    return JSON.parse(localStorage.getItem(OPERATOR_KEY) || "null");
  } catch {
    return null;
  }
}

function saveOperador(op) {
  localStorage.setItem(OPERATOR_KEY, JSON.stringify(op));
}

function clearOperador() {
  localStorage.removeItem(OPERATOR_KEY);
}

function operadorLabel(op) {
  return op.dni ? `${op.nombre} (DNI ${op.dni})` : op.nombre;
}

// Muestra el pop-up de login. El resto de la app queda detrás, no se navega a otra ruta.
function showLogin() {
  el.loginModal.hidden = false;
  el.operatorBar.hidden = true;
  if (html5QrCode) {
    html5QrCode.stop().catch(() => {});
  }
}

// Cierra el pop-up de login y deja visible la app (que ya estaba montada detrás).
function showApp() {
  el.loginModal.hidden = true;
  el.operatorBar.hidden = false;
  el.operatorName.textContent = operadorLabel(operador);
}

el.btnLogin.addEventListener("click", () => {
  const nombre = el.loginNombre.value.trim();
  const dni = el.loginDni.value.trim();
  if (!nombre || !dni) {
    el.loginError.hidden = false;
    return;
  }
  el.loginError.hidden = true;
  operador = { nombre, dni };
  saveOperador(operador);
  showApp();
  initCameraAndScanner();
});

el.btnLogout.addEventListener("click", () => {
  if (html5QrCode) {
    html5QrCode.stop().catch(() => {});
  }
  clearOperador();
  operador = null;
  el.loginNombre.value = "";
  el.loginDni.value = "";
  showLogin();
});

let cameras = [];
let currentCameraIndex = 0;
let html5QrCode = null;
let torchOn = false;
let lastScanValue = null;
let lastScanAt = 0;
let totalCount = 0;

// ---------- Utilidades de cola offline ----------

function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  renderQueueStatus(q.length);
}

function renderQueueStatus(n) {
  if (n > 0) {
    el.queueStatus.hidden = false;
    el.queueStatus.textContent = `⏳ ${n} pendiente(s) por sincronizar`;
  } else {
    el.queueStatus.hidden = true;
  }
}

async function flushQueue() {
  const q = getQueue();
  if (q.length === 0) return;
  const remaining = [];
  for (const record of q) {
    const { error } = await sb.from(TABLE).insert(record);
    if (error && error.code !== "23505") {
      // sigue sin poder enviarse (ej. sin internet todavía) -> se queda en la cola
      remaining.push(record);
    }
    // si fue éxito, o si ya existía (23505), se descarta de la cola
  }
  saveQueue(remaining);
}

// ---------- Estado de conexión ----------

function updateConnStatus() {
  const online = navigator.onLine;
  el.connStatus.textContent = online ? "● en línea" : "● sin conexión";
  el.connStatus.className = "pill " + (online ? "online" : "offline");
  if (online) flushQueue();
}

window.addEventListener("online", updateConnStatus);
window.addEventListener("offline", updateConnStatus);

// ---------- Contador ----------

async function refreshCounter() {
  const { count, error } = await sb
    .from(TABLE)
    .select("*", { count: "exact", head: true });
  if (!error && typeof count === "number") {
    totalCount = count;
    el.btnAttendance.textContent = `${totalCount} registrado(s)`;
  }
}

// ---------- Resultado visual ----------

function showResult(kind, title, data) {
  el.resultCard.hidden = false;
  el.resultCard.className = "result-card " + kind;
  el.resultIcon.textContent = kind === "ok" ? "✅" : kind === "dup" ? "⚠️" : "❌";
  el.resultTitle.textContent = title;
  el.resultFields.innerHTML = "";
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      const div = document.createElement("div");
      div.innerHTML = `<b>${k}:</b> ${escapeHtml(String(v))}`;
      el.resultFields.appendChild(div);
    }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function addToHistory(record, statusLabel) {
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  li.innerHTML = `<span>${escapeHtml(record.asistente)} <span class="small">(${escapeHtml(record.dni)})</span></span><span class="small">${statusLabel} · ${time}</span>`;
  el.historyList.prepend(li);
  while (el.historyList.children.length > 15) {
    el.historyList.removeChild(el.historyList.lastChild);
  }
}

// ---------- Parseo del contenido del QR ----------

function parseQrPayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const dni = data.DNI ?? data.dni;
  const asistente = data.ASISTENTE ?? data.asistente;
  const coordinador = data.COORDINADOR ?? data.coordinador;
  const campana = data.CAMPANA ?? data.campana ?? data["CAMPAÑA"];
  if (!dni || !asistente || !coordinador || !campana) return null;
  return {
    dni: String(dni).trim(),
    asistente: String(asistente).trim(),
    coordinador: String(coordinador).trim(),
    campana: String(campana).trim(),
  };
}

// ---------- Registro en Supabase ----------

async function registerScan(record) {
  const payload = { ...record, escaneado_por: operador ? operadorLabel(operador) : null };

  if (!navigator.onLine) {
    const q = getQueue();
    q.push(payload);
    saveQueue(q);
    showResult("dup", "Sin conexión — guardado para sincronizar", record);
    addToHistory(record, "en cola");
    beep(440, 120);
    return;
  }

  const { error } = await sb.from(TABLE).insert(payload);

  if (!error) {
    totalCount += 1;
    el.btnAttendance.textContent = `${totalCount} registrado(s)`;
    showResult("ok", "Asistencia registrada", record);
    addToHistory(record, "registrado");
    beep(880, 120);
    return;
  }

  if (error.code === "23505") {
    // DNI ya existía -> lo tratamos como "ya había ingresado"
    const { data: existing } = await sb
      .from(TABLE)
      .select("*")
      .eq("dni", record.dni)
      .maybeSingle();
    showResult("dup", "Este DNI ya fue registrado antes", existing || record);
    addToHistory(record, "duplicado");
    beep(300, 200);
    return;
  }

  // Mostrar el error real de Supabase
  console.error("ERROR SUPABASE:", error);

  showResult("err", "Error de Supabase", {
    codigo: error.code || "N/A",
    mensaje: error.message || "Sin mensaje",
    detalle: error.details || "",
    hint: error.hint || "",
  });

  addToHistory(record, "error");
  beep(220, 250);
}

function beep(freq, duration) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {
    /* audio no disponible, no pasa nada */
  }
}

// ---------- Escáner de cámara ----------

async function onScanSuccess(decodedText) {
  const now = Date.now();
  if (decodedText === lastScanValue && now - lastScanAt < SCAN_COOLDOWN_MS) {
    return; // ignora el mismo QR escaneado repetidamente en poco tiempo
  }
  lastScanValue = decodedText;
  lastScanAt = now;

  const record = parseQrPayload(decodedText);
  if (!record) {
    showResult("err", "QR no reconocido", { contenido: decodedText.slice(0, 80) });
    beep(220, 250);
    return;
  }
  await registerScan(record);
}

function onScanFailure() {
  // se llama constantemente mientras no hay QR en cámara; se ignora a propósito
}

async function startScanner(cameraId) {
  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode("reader");
  } else {
    try { await html5QrCode.stop(); } catch { /* ya estaba detenido */ }
  }
  await html5QrCode.start(
    cameraId,
    { fps: 10, qrbox: { width: 260, height: 260 } },
    onScanSuccess,
    onScanFailure
  );

  // Muestra el botón de linterna solo si el dispositivo lo soporta
  try {
    const capabilities = html5QrCode.getRunningTrackCapabilities?.();
    if (capabilities && capabilities.torch) {
      el.btnTorch.hidden = false;
    } else {
      el.btnTorch.hidden = true;
    }
  } catch {
    el.btnTorch.hidden = true;
  }
}

async function initCameraAndScanner() {
  try {
    cameras = await Html5Qrcode.getCameras();
  } catch (e) {
    showResult("err", "No se pudo acceder a la cámara", { detalle: String(e) });
    return;
  }
  if (!cameras || cameras.length === 0) {
    showResult("err", "No se encontró ninguna cámara", null);
    return;
  }
  // Prioriza cámara trasera si el label lo indica
  const backIndex = cameras.findIndex((c) => /back|trasera|rear|environment/i.test(c.label));
  currentCameraIndex = backIndex >= 0 ? backIndex : 0;
  await startScanner(cameras[currentCameraIndex].id);
}

el.btnToggleCamera.addEventListener("click", async () => {
  if (cameras.length < 2) return;
  currentCameraIndex = (currentCameraIndex + 1) % cameras.length;
  await startScanner(cameras[currentCameraIndex].id);
});

el.btnTorch.addEventListener("click", async () => {
  try {
    torchOn = !torchOn;
    await html5QrCode.applyVideoConstraints({ advanced: [{ torch: torchOn }] });
  } catch {
    /* algunos dispositivos no lo soportan */
  }
});

// ---------- Pop-up: asistentes registrados ----------

let attendanceData = []; // cache de la última carga, para filtrar en el cliente sin golpear la BD en cada tecla

// Nombres de columna de fecha que podrían existir en la tabla, según cómo se haya creado
const POSSIBLE_DATE_FIELDS = ["created_at", "inserted_at", "fecha", "fecha_registro", "timestamp"];

function getDateField(record) {
  for (const key of POSSIBLE_DATE_FIELDS) {
    if (record[key]) return record[key];
  }
  return null;
}

async function fetchAttendance() {
  // Intenta ordenar por fecha de creación; si la columna no existe en tu tabla, reintenta sin orden.
  let { data, error } = await sb.from(TABLE).select("*").order("created_at", { ascending: false });
  if (error) {
    const retry = await sb.from(TABLE).select("*");
    data = retry.data;
    error = retry.error;
  }
  return { data: data || [], error };
}

function matchesSearch(record, term) {
  if (!term) return true;
  return ["dni", "asistente", "coordinador", "campana"].some((key) =>
    String(record[key] ?? "").toLowerCase().includes(term)
  );
}

function renderAttendanceList() {
  const term = el.attendanceSearch.value.trim().toLowerCase();
  const filtered = attendanceData.filter((r) => matchesSearch(r, term));

  el.attendanceList.innerHTML = "";

  if (filtered.length === 0) {
    el.attendanceEmpty.hidden = false;
    el.attendanceEmpty.textContent = "No se encontraron resultados.";
    return;
  }
  el.attendanceEmpty.hidden = true;

  for (const r of filtered) {
    const li = document.createElement("li");
    const dateField = getDateField(r);
    const timeLabel = dateField
      ? new Date(dateField).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
      : "Hora no disponible";
    li.innerHTML = `
      <div class="att-name">${escapeHtml(String(r.asistente ?? ""))}</div>
      <div class="att-meta">DNI ${escapeHtml(String(r.dni ?? ""))} · ${escapeHtml(String(r.coordinador ?? ""))} · ${escapeHtml(String(r.campana ?? ""))}</div>
      <div class="att-meta">${escapeHtml(timeLabel)}</div>
    `;
    el.attendanceList.appendChild(li);
  }
}

async function openAttendanceModal() {
  el.attendanceModal.hidden = false;
  el.attendanceSearch.value = "";
  el.attendanceList.innerHTML = "";
  el.attendanceEmpty.hidden = true;
  el.attendanceLoading.hidden = false;

  const { data, error } = await fetchAttendance();

  el.attendanceLoading.hidden = true;

  if (error) {
    console.error("ERROR SUPABASE (lista de asistentes):", error);
    attendanceData = [];
    el.attendanceEmpty.hidden = false;
    el.attendanceEmpty.textContent = "No se pudo cargar la lista de asistentes.";
    return;
  }

  attendanceData = data;
  renderAttendanceList();
}

function closeAttendanceModal() {
  el.attendanceModal.hidden = true;
}

el.btnAttendance.addEventListener("click", openAttendanceModal);
el.btnCloseAttendance.addEventListener("click", closeAttendanceModal);
el.attendanceSearch.addEventListener("input", renderAttendanceList);

// Cierra el pop-up al tocar el fondo (fuera de la tarjeta)
el.attendanceModal.addEventListener("click", (e) => {
  if (e.target === el.attendanceModal) closeAttendanceModal();
});

// ---------- Arranque ----------

(async function main() {
  updateConnStatus();
  renderQueueStatus(getQueue().length);
  await refreshCounter();

  operador = loadOperador();
  if (operador) {
    showApp();
    await initCameraAndScanner();
  } else {
    showLogin();
  }

  if (navigator.onLine) flushQueue();
  setInterval(() => { if (navigator.onLine) flushQueue(); }, 15000);
})();
