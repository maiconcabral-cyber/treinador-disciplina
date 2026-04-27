// safety.js — camada de detecção de crise por palavras-chave
// Roda ANTES do classificador. Se positivo, força intenção "crise"
// independente do que o LLM diria. Custo zero, latência zero, à prova de falha.

const PALAVRAS_CRISE_FORTES = [
  // Ideação direta
  "me matar",
  "me machucar",
  "suicídio",
  "suicidio",
  "me cortar",
  "tirar minha vida",
  "acabar com tudo",
  "queria morrer",
  "quero morrer",
  "queria sumir",
  "quero sumir",
  "sumir do mapa",
  "não quero mais viver",
  "nao quero mais viver",
  "não quero viver",
  "nao quero viver",
  "desaparecer pra sempre",
  "desaparecer para sempre",
  // Desesperança severa
  "não aguento mais",
  "nao aguento mais",
  "não aguento",
  "nao aguento",
  "não vejo saída",
  "nao vejo saida",
  "sem saída",
  "sem saida",
  "no fundo do poço",
  "no fundo do poco",
  "vou desistir de tudo",
  "não tenho mais forças",
  "nao tenho mais forcas",
  "não tenho forças pra nada",
  "nao tenho forcas pra nada",
  "tô no meu limite",
  "to no meu limite",
  "no meu limite",
  // Vazio existencial agudo
  "nada faz sentido",
  "nada adianta mais",
  "tudo perdeu o sentido"
];

export function detectarCriseCritica(mensagem) {
  if (!mensagem || typeof mensagem !== "string") return false;
  const msgLower = mensagem.toLowerCase();
  return PALAVRAS_CRISE_FORTES.some((palavra) => msgLower.includes(palavra));
}

// Resposta fixa para casos de crise — não depende do LLM
export const RESPOSTA_CRISE = `Pausa. O que você descreveu é sério e merece cuidado real, não disciplina.

Liga agora no CVV: 188 (24h, gratuito, sigiloso). Se houver risco imediato, SAMU 192.

Quando estiver seguro, voltamos à rotina. Não some — me avisa que está bem.`;
