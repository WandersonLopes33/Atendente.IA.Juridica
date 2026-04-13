const logger = require('../utils/logger');

/**
 * Grok AI Service (xAI)
 * Usado especificamente para buscas jurídicas na internet em tempo real.
 * O Groq continua sendo o provedor principal para respostas normais.
 */
class GrokAIService {
    constructor() {
        this.apiKey = process.env.XAI_API_KEY;
        this.model = 'grok-3-fast';
        this.baseURL = 'https://api.x.ai/v1';

        if (!this.apiKey) {
            logger.warn('GrokAI: XAI_API_KEY não configurada — busca jurídica na web desativada');
        } else {
            logger.info('Grok AI Service inicializado', { model: this.model });
        }
    }

    /**
     * Verifica se o serviço está disponível
     */
    isAvailable() {
        return !!this.apiKey;
    }

    /**
     * Detecta se a mensagem do cliente pede informação jurídica atualizada
     * que se beneficiaria de uma busca na web.
     * 
     * Exemplos que ATIVAM a busca:
     * - "qual o prazo para recorrer?"
     * - "mudou alguma lei sobre FGTS?"
     * - "qual a tabela do INSS 2024?"
     * - "jurisprudência sobre assédio moral"
     * 
     * Exemplos que NÃO ativam (resposta normal pelo Groq):
     * - "quero falar com o advogado"
     * - "qual o horário de vocês?"
     * - "preciso de ajuda com divórcio"
     */
    needsWebSearch(message) {
        const gatilhos = [
            // Prazos e legislação atualizada
            'prazo', 'lei', 'legislação', 'mudou', 'alterou', 'nova lei',
            'atualização', 'atualizado', 'vigente', 'vigência',
            // Valores e tabelas
            'tabela', 'valor', 'salário mínimo', 'teto do inss', 'índice',
            'correção', 'juros', 'multa', 'percentual',
            // Jurisprudência
            'jurisprudência', 'súmula', 'decisão recente', 'stj', 'stf',
            'tribunal superior', 'acórdão', 'tst',
            // Perguntas diretas sobre leis
            'qual a lei', 'o que diz a lei', 'artigo', 'parágrafo',
            'inciso', 'código civil', 'clt', 'código do consumidor',
            // Benefícios INSS
            'inss', 'aposentadoria', 'benefício', 'bpc', 'loas',
            // Pesquisa explícita
            'pesquisa', 'busca', 'pesquise', 'procure', 'verifique',
            'informação atualizada', 'dado atualizado'
        ];

        const msgLower = message.toLowerCase();
        return gatilhos.some(gatilho => msgLower.includes(gatilho));
    }

    /**
     * Busca informação jurídica na web e retorna resposta formatada
     * para o contexto do escritório Lopes Advocacia.
     *
     * @param {string} pergunta - Dúvida jurídica do cliente
     * @param {string} clienteNome - Nome do cliente para personalizar resposta
     * @returns {Promise<{success: boolean, content: string, usedWebSearch: boolean}>}
     */
    async buscarInformacaoJuridica(pergunta, clienteNome = 'cliente') {
        if (!this.isAvailable()) {
            return {
                success: false,
                content: null,
                usedWebSearch: false,
                error: 'XAI_API_KEY não configurada'
            };
        }

        try {
            logger.info('GrokAI: iniciando busca jurídica na web', {
                pergunta: pergunta.substring(0, 100),
                cliente: clienteNome
            });

            const systemPrompt = `Você é um assistente jurídico do escritório Lopes Advocacia, em Imperatriz-MA.
Seu papel é fornecer ORIENTAÇÕES GERAIS baseadas na legislação brasileira atualizada.

REGRAS OBRIGATÓRIAS:
- Respostas CURTAS (máximo 5 linhas para o cliente)
- Use linguagem SIMPLES, acessível ao leigo
- SEMPRE termine dizendo que é uma orientação geral e recomende consulta com o Dr. Wanderson Lopes
- NUNCA dê consultoria jurídica específica para o caso do cliente
- NUNCA invente leis ou artigos — busque informações reais e atualizadas
- Se encontrar dados desatualizados, informe o ano da informação
- Tom formal e acolhedor`;

            const userPrompt = `O cliente "${clienteNome}" perguntou: "${pergunta}"

Busque informações jurídicas atualizadas sobre este tema na legislação brasileira e responda de forma clara e resumida.
Lembre-se: orientação geral apenas, sempre recomendando consulta presencial.`;

            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    tools: [
                        { type: 'web_search_20250305', name: 'web_search' }
                    ],
                    max_tokens: 600,
                    temperature: 0.3
                })
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Grok API HTTP ${response.status}: ${err}`);
            }

            const data = await response.json();

            // Extrair conteúdo de texto da resposta (pode vir misturado com tool_use)
            const content = data.choices[0]?.message?.content;
            let textoResposta = '';

            if (Array.isArray(content)) {
                textoResposta = content
                    .filter(block => block.type === 'text')
                    .map(block => block.text)
                    .join('\n')
                    .trim();
            } else if (typeof content === 'string') {
                textoResposta = content.trim();
            }

            if (!textoResposta) {
                throw new Error('Resposta vazia do Grok');
            }

            logger.info('GrokAI: busca jurídica concluída com sucesso', {
                cliente: clienteNome,
                responseLength: textoResposta.length
            });

            return {
                success: true,
                content: textoResposta,
                usedWebSearch: true
            };

        } catch (error) {
            logger.error('GrokAI: erro na busca jurídica', {
                error: error.message,
                cliente: clienteNome
            });

            return {
                success: false,
                content: null,
                usedWebSearch: false,
                error: error.message
            };
        }
    }

    /**
     * Verifica conexão com a API xAI
     */
    async checkHealth() {
        if (!this.isAvailable()) return false;

        try {
            const response = await fetch(`${this.baseURL}/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });

            const ok = response.ok;
            logger.info(`GrokAI health check: ${ok ? 'OK' : 'FALHOU'}`);
            return ok;
        } catch (error) {
            logger.error('GrokAI health check falhou', { error: error.message });
            return false;
        }
    }
}

module.exports = new GrokAIService();