// responder.js — geração da resposta final
// Modelo padrão: claude-sonnet-4-6 (qualidade alta, custo médio)

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY
});

const RESPONDER_MODEL = process.env.RESPONDER_MODEL || "claude-sonnet-4-6";

const RESPONDER_SYSTEM = fs.readFileSync(
  path.join(__dirname, "prompts", "responder.md"),
  "utf-8"
);

export async function gerarResposta(payload) {
  const resp = await client.messages.create({
    model: RESPONDER_MODEL,
    max_tokens: 400,
    temperature: 0.7, // alguma variação ajuda anti-repetição
    system: RESPONDER_SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify(payload, null, 2)
      }
    ]
  });

  return resp.content?.[0]?.text || "";
}

// Extrai a linha de Diagnóstico para alimentar `ultimas_3_aberturas`
export function extrairAbertura(resposta) {
  const linhas = resposta.split("\n");
  const idx = linhas.findIndex((l) => /diagn[oó]stico/i.test(l));
  if (idx === -1) return null;
  // Próxima linha não-vazia após "Diagnóstico:"
  for (let i = idx + 1; i < linhas.length; i++) {
    const t = linhas[i].trim();
    if (t) return t;
  }
  return null;
}

// Converte **bold** do markdown para <b>bold</b> do HTML do Telegram
// e escapa caracteres reservados
export function formatarParaTelegram(texto) {
  let html = texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  return html;
}
