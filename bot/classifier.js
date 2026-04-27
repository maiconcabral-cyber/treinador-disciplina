// classifier.js — chamada de LLM barata e rápida que decide a intenção
// Modelo padrão: claude-haiku-4-5 (10x mais barato que sonnet)

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY
});

const CLASSIFIER_MODEL =
  process.env.CLASSIFIER_MODEL || "claude-haiku-4-5-20251001";

const CLASSIFIER_SYSTEM = fs.readFileSync(
  path.join(__dirname, "prompts", "classificador.md"),
  "utf-8"
);

const FALLBACK = {
  intencao: "neutro",
  confianca: 0.3,
  sinais: [],
  ambiguidade: "falha de classificação — fallback aplicado"
};

function extrairJSON(texto) {
  // Remove cercas de markdown se existirem
  let limpo = texto.trim();
  limpo = limpo.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  // Pega o primeiro bloco {...}
  const match = limpo.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("nenhum JSON encontrado na resposta");
  return JSON.parse(match[0]);
}

export async function classificarIntencao(mensagemUsuario) {
  if (!mensagemUsuario || !mensagemUsuario.trim()) return FALLBACK;

  try {
    const resp = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 250,
      temperature: 0,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: mensagemUsuario }]
    });

    const texto = resp.content?.[0]?.text || "";
    const parsed = extrairJSON(texto);

    // Validação mínima do shape
    const intencoesValidas = [
      "concluiu",
      "falhou",
      "neutro",
      "duvida",
      "fora_escopo",
      "crise"
    ];
    if (!intencoesValidas.includes(parsed.intencao)) {
      console.warn("classifier: intenção inválida, usando fallback", parsed);
      return FALLBACK;
    }

    return {
      intencao: parsed.intencao,
      confianca: Number(parsed.confianca) || 0.5,
      sinais: Array.isArray(parsed.sinais) ? parsed.sinais : [],
      ambiguidade: parsed.ambiguidade || null
    };
  } catch (err) {
    console.error("classifier: erro na chamada", err.message);
    return FALLBACK;
  }
}
