// storage.js — persistência simples em JSON file
// Para produção real, troque por SQLite, Redis ou Postgres.
// A interface (getUser, updateUser, pushAbertura) deve permanecer igual.

import fs from "fs";
import path from "path";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data/users.json";

const DEFAULT_USER = {
  score: 50,
  streak: 0,
  executou_hoje: false,
  tarefas: [],
  ultimas_3_aberturas: [],
  em_modo_seguro: false,
  ultima_classificacao_crise: null,
  criado_em: null,
  atualizado_em: null
};

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
    ...(data[id] || DEFAULT_USER),
    ...updates,
    atualizado_em: new Date().toISOString()
  };
  save(data);
  return data[id];
}

export function pushAbertura(userId, abertura) {
  const user = getUser(userId);
  const aberturas = [...(user.ultimas_3_aberturas || []), abertura].slice(-3);
  return updateUser(userId, { ultimas_3_aberturas: aberturas });
}

// Operações de tarefa — para você usar nos comandos /add /done /listar
export function addTarefa(userId, tarefa) {
  const user = getUser(userId);
  const tarefas = [...(user.tarefas || []), tarefa];
  return updateUser(userId, { tarefas });
}

export function removerTarefa(userId, indice) {
  const user = getUser(userId);
  const tarefas = (user.tarefas || []).filter((_, i) => i !== indice);
  return updateUser(userId, { tarefas });
}

export function marcarExecutado(userId, executou = true) {
  const user = getUser(userId);
  const updates = { executou_hoje: executou };
  if (executou) {
    updates.streak = (user.streak || 0) + 1;
    updates.score = Math.min(100, (user.score || 50) + 5);
  } else {
    updates.streak = 0;
    updates.score = Math.max(0, (user.score || 50) - 3);
  }
  return updateUser(userId, updates);
}
