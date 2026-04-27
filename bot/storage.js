// storage.js — persistência simples em JSON file
// Para produção real, troque por SQLite, Redis ou Postgres.
// No Railway, sem Volume montado, o arquivo se perde a cada redeploy.
// Solução: monte um Volume em /data e defina STORAGE_PATH=/data/users.json.

import fs from "fs";
import path from "path";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data/users.json";

const DEFAULT_USER = {
  score: 50,
  streak: 0,
  executou_hoje: false,
  ultimo_check: null, // YYYY-MM-DD do último reset diário
  tarefas: [], // [{ id, texto, criadaEm, status, concluidaEm }]
  ultimas_3_aberturas: [],
  em_modo_seguro: false,
  ultima_classificacao_crise: null,
  criado_em: null,
  atualizado_em: null
};

// ---------------- Infra de arquivo ----------------

function ensureFile() {
  const dir = path.dirname(STORAGE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STORAGE_PATH)) fs.writeFileSync(STORAGE_PATH, "{}");
}

function load() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(STORAGE_PATH, "utf-8"));
  } catch (err) {
    console.error("storage: falha ao ler arquivo, recriando", err);
    fs.writeFileSync(STORAGE_PATH, "{}");
    return {};
  }
}

function save(data) {
  ensureFile();
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2));
}

function gerarId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function hojeStr() {
  return new Date().toISOString().split("T")[0];
}

// ---------------- API de usuário ----------------

export function getUser(userId) {
  const data = load();
  const id = String(userId);
  if (!data[id]) {
    data[id] = { ...DEFAULT_USER, criado_em: new Date().toISOString() };
    save(data);
  }
  return data[id];
}

export function updateUser(userId, updates) {
  const data = load();
  const id = String(userId);
  data[id] = {
    ...DEFAULT_USER,
    ...(data[id] || {}),
    ...updates,
    atualizado_em: new Date().toISOString()
  };
  save(data);
  return data[id];
}

export function pushAbertura(userId, abertura) {
  if (!abertura) return getUser(userId);
  const user = getUser(userId);
  const aberturas = [...(user.ultimas_3_aberturas || []), abertura].slice(-3);
  return updateUser(userId, { ultimas_3_aberturas: aberturas });
}

export function listarChatIds() {
  const data = load();
  return Object.keys(data);
}

// ---------------- API de tarefas ----------------

export function addTarefas(userId, listaDeTextos) {
  if (!Array.isArray(listaDeTextos) || listaDeTextos.length === 0)
    return getUser(userId);
  const user = getUser(userId);
  const novas = listaDeTextos
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    .map((texto) => ({
      id: gerarId(),
      texto,
      criadaEm: hojeStr(),
      status: "pendente",
      concluidaEm: null
    }));
  const tarefas = [...(user.tarefas || []), ...novas];
  return updateUser(userId, { tarefas });
}

// Marca tarefas como feitas. `seletores` é um array onde cada item pode ser:
// - número 1..N → índice 1-based dentro das pendentes ATUAIS
// - string → match parcial (case-insensitive) no texto da tarefa pendente
// - id ("t_xxx") → match direto no campo id
// Retorna { user, marcadas: [tarefa] }
export function marcarTarefasFeitas(userId, seletores) {
  const user = getUser(userId);
  const tarefas = [...(user.tarefas || [])];
  const pendentes = tarefas.filter((t) => t.status === "pendente");
  const marcadas = [];

  for (const sel of seletores || []) {
    let alvo = null;

    if (typeof sel === "number") {
      const idx = sel - 1;
      if (idx >= 0 && idx < pendentes.length) alvo = pendentes[idx];
    } else if (typeof sel === "string") {
      if (sel.startsWith("t_")) {
        alvo = tarefas.find((t) => t.id === sel && t.status === "pendente");
      } else {
        const q = sel.toLowerCase();
        alvo = pendentes.find((t) => t.texto.toLowerCase().includes(q));
      }
    }

    if (alvo && !marcadas.find((m) => m.id === alvo.id)) {
      const i = tarefas.findIndex((t) => t.id === alvo.id);
      tarefas[i] = {
        ...tarefas[i],
        status: "feita",
        concluidaEm: hojeStr()
      };
      marcadas.push(tarefas[i]);
    }
  }

  const userAtualizado = updateUser(userId, { tarefas });
  return { user: userAtualizado, marcadas };
}

export function descartarTarefa(userId, seletor) {
  const user = getUser(userId);
  const tarefas = [...(user.tarefas || [])];
  const pendentes = tarefas.filter((t) => t.status === "pendente");
  let alvo = null;

  if (typeof seletor === "number") {
    const idx = seletor - 1;
    if (idx >= 0 && idx < pendentes.length) alvo = pendentes[idx];
  } else if (typeof seletor === "string") {
    if (seletor.startsWith("t_")) {
      alvo = tarefas.find((t) => t.id === seletor && t.status === "pendente");
    } else {
      const q = seletor.toLowerCase();
      alvo = pendentes.find((t) => t.texto.toLowerCase().includes(q));
    }
  }

  if (!alvo) return { user, descartada: null };
  const i = tarefas.findIndex((t) => t.id === alvo.id);
  tarefas[i] = { ...tarefas[i], status: "descartada", concluidaEm: hojeStr() };
  const userAtualizado = updateUser(userId, { tarefas });
  return { user: userAtualizado, descartada: tarefas[i] };
}

// Tarefas pendentes nos últimos `dias` dias (inclui hoje).
export function getTarefasPendentes(userId, dias = 3) {
  const user = getUser(userId);
  const hoje = new Date();
  const limite = new Date(hoje.getTime() - dias * 24 * 60 * 60 * 1000);
  const limiteStr = limite.toISOString().split("T")[0];
  return (user.tarefas || []).filter(
    (t) => t.status === "pendente" && t.criadaEm >= limiteStr
  );
}
