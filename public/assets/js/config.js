/* FN · Reset Metabólico v3 · CONFIGURAÇÃO
   Este é o único arquivo que muda a cada edição do desafio.
   Datas no formato AAAA-MM-DD. Deixe "" para o que ainda não existe. */
window.FN_CONFIG = {
  // Datas do desafio
  inscricoesAte: "",        // ex.: "2026-11-27" · último dia para se inscrever
  materialEm:    "",        // ex.: "2026-11-28" · sábado em que o material chega no grupo
  inicioEm:      "",        // ex.: "2026-11-30" · segunda-feira, dia 1

  // Grupo do WhatsApp (o mesmo da página de obrigado atual)
  grupoWhatsApp: "https://chat.whatsapp.com/CTPBz5hbeLc6xRxh02tF76",

  // Suporte: número no formato internacional, só dígitos (ex.: "447700900123")
  suporteWhatsApp: "",

  // Para onde o e-mail é enviado. "/api/lead" é a função do Cloudflare (src/worker.js), que repassa
  // para o webhook guardado como segredo LEAD_WEBHOOK_URL. Vazio = só redireciona (modo teste).
  formEndpoint: "/api/lead",

  // Respostas das duas perguntas da página de obrigado → segredo ANSWERS_WEBHOOK_URL
  respostasEndpoint: "/api/answers",

  // Caminhos (relativos a cada página)
  paginaObrigado: "../obrigado-reset-metabolico-v3/",
  politicaPrivacidade: "https://desafiofernandanadaline.com/politica-de-privacidade/",

  // Vídeos: deixe o arquivo em assets/video/ com estes nomes. Se o arquivo não existir, a página mostra a foto.
  videos: {
    sobre: "../assets/video/fernanda-londres.mp4",
    boasVindas: "../assets/video/fernanda-boas-vindas.mp4"
  }
};
