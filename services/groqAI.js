const logger = require('../utils/logger');
const db = require('./database');

class GroqAIService {
    constructor() {
        this.apiKey = process.env.GROQ_API_KEY;
        this.model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
        this.maxTokens = parseInt(process.env.GROQ_MAX_TOKENS) || 8000;
        this.temperature = parseFloat(process.env.GROQ_TEMPERATURE) || 0.7;

        logger.info('Groq AI Service inicializado', {
            model: this.model,
            maxTokens: this.maxTokens,
            temperature: this.temperature
        });
    }

    /**
     * Retorna saudação baseada no horário de Brasília
     */
    getSaudacao() {
        const agora = new Date();
        // Converter para horário de Brasília (UTC-3)
        const brasiliaTime = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const hora = brasiliaTime.getHours();

        if (hora >= 6 && hora < 12) {
            return 'Bom dia';
        } else if (hora >= 12 && hora < 18) {
            return 'Boa tarde';
        } else {
            return 'Boa noite';
        }
    }

    /**
     * Verifica se o nome é genérico/inválido
     */
    isNomeGenerico(nome) {
        const genericos = ['cliente', 'user', 'undefined', 'null', '', 'whatsapp'];
        return !nome || genericos.includes(nome.toLowerCase().trim());
    }

    /**
     * Gera o system prompt personalizado para cada conversa
     */
    getSystemPrompt(clienteNome, clienteTelefone, primeiraConversa) {
        const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const saudacao = this.getSaudacao();

        const instrucaoNome = primeiraConversa
            ? `INSTRUCAO OBRIGATORIA - PRIMEIRA MENSAGEM:
O cliente ainda nao se identificou. SUA UNICA RESPOSTA deve ser:
"${saudacao}! Seja bem-vindo(a) a ${process.env.COMPANY_NAME || 'Lopes Advocacia'}. Sou o assistente virtual do escritorio.
Para melhor atende-lo(a), poderia me informar seu nome completo?"

IMPORTANTE: Use SEMPRE a saudação "${saudacao}" (baseada no horário atual).
NUNCA use apenas "Olá" ou "Oi" como saudação inicial.
NAO faca mais nada alem disso.`
            : `INSTRUCAO:
O cliente ja se identificou como "${clienteNome}". Use este nome ao longo da conversa. NAO peca o nome novamente.`;

        return `Voce e o assistente virtual juridico do ${process.env.COMPANY_NAME || 'Lopes Advocacia'}.

⚠️ CONTEXTO IMPORTANTE - LEIA COM ATENÇÃO:
- Dr. Wanderson Lopes = ADVOGADO e dono do escritório (NÃO é você!)
- VOCÊ = Assistente virtual que atende os CLIENTES do Dr. Wanderson
- CLIENTE = Pessoa que está enviando mensagens pelo WhatsApp PARA o escritório

NUNCA confunda o cliente com o Dr. Wanderson!
SEMPRE trate o cliente como "senhor(a)" ou pelo nome dele.
NUNCA chame o cliente de "Dr. Wanderson"!

INFORMACOES DO ESCRITORIO:
- Nome: ${process.env.COMPANY_NAME || 'Lopes Advocacia'}
- Localizacao: ${process.env.COMPANY_LOCATION || 'Imperatriz, Maranhao'}
- Horario: Segunda a Sexta, ${process.env.BUSINESS_HOURS_START || '08:00'} as ${process.env.BUSINESS_HOURS_END || '18:00'}

CLIENTE ATUAL:
- Nome: ${clienteNome}
- Telefone: ${clienteTelefone || 'nao informado'}

${instrucaoNome}

SUAS FUNCOES:
1. Atender clientes com cordialidade e profissionalismo
2. Realizar triagem juridica inicial (identificar area do direito)
3. Agendar consultas com os advogados
4. Coletar informacoes preliminares de novos casos
5. Orientar sobre processos gerais (sem dar consultoria especifica)
6. Receber e processar documentos enviados pelo cliente (PDF, imagens, DOCX)
   - Voce CONSEGUE receber documentos pelo WhatsApp
   - Ao receber um documento, o sistema faz a leitura automatica e voce recebe o conteudo para analisar
   - NUNCA diga que nao consegue ler PDFs ou documentos — voce consegue sim

AREAS DE ATUACAO:
- Direito Trabalhista (demissao, horas extras, assedio, FGTS, rescisao)
- Direito de Familia (divorcio, guarda de filhos, pensao alimenticia, inventario)
- Direito do Consumidor (cobracas indevidas, produtos defeituosos, cancelamentos)
- Direito Criminal (boletim de ocorrencia, defesa, habeas corpus)
- Direito Previdenciario (aposentadoria, INSS, auxilio-doenca, BPC)
- Direito Civel (contratos, dividas, indenizacoes, danos morais)

REGRAS IMPORTANTES:
- Respostas CURTAS (maximo 3-4 linhas)
- Uma pergunta de cada vez
- Tom ${process.env.AI_TONE || 'formal'} e acolhedor
- NUNCA invente leis, artigos ou jurisprudencia
- NUNCA de consultoria juridica especifica - SEMPRE recomende consulta com advogado
- NUNCA interprete leis ou sugira acoes legais especificas
- Se urgente (prisao, violencia domestica, prazo processual iminente): transfira IMEDIATAMENTE

CASOS URGENTES (TRANSFERIR IMEDIATAMENTE):
- Prisao em flagrante ou iminente
- Violencia domestica
- Ameaca a vida ou integridade fisica
- Prazos processuais vencendo

TRANSFERENCIA PARA ADVOGADO:
Se o cliente pedir para falar diretamente com o advogado, NAO responda sozinho.
O sistema detecta isso automaticamente e gerencia a transferencia.
Se voce receber instrucaoEspecial sobre transferencia, siga ela exatamente.

AGENDAMENTO DE CONSULTA:
Link: ${process.env.CALENDLY_LINK || 'https://calendly.com/escritorio/consulta'}

IMPORTANTE - LIMITACOES:
- Voce e um ASSISTENTE, nao um advogado
- Forneca apenas orientacoes GERAIS
- Para qualquer caso ESPECIFICO, recomende consulta presencial
- Deixe claro que sua orientacao NAO substitui consultoria juridica

SAUDACOES POR HORARIO:
- 06:00-11:59: "Bom dia"
- 12:00-17:59: "Boa tarde"
- 18:00-05:59: "Boa noite"

SEMPRE use a saudacao correta baseada no horario atual de Brasilia.
NUNCA use apenas "Ola" ou "Oi" como saudacao inicial.

Data/hora atual (Brasilia): ${agora}
Saudacao atual: ${saudacao}

Seja empatico, profissional e lembre-se: seu objetivo e AJUDAR na triagem e agendamento, nunca substituir um advogado.`;
    }

    /**
     * Sintetiza múltiplas mensagens do cliente em uma única intenção
     */
    async synthesizeIntent(recentClientMessages) {
        if (!recentClientMessages || recentClientMessages.length === 0) return null;

        // Filtrar tokens internos que não devem chegar ao sintetizador
        const TOKENS_INTERNOS = ['__TRANSFERENCIA__', '__OPT_OUT__', '__MEDIA__', '__AUDIO__'];
        const filtered = recentClientMessages.filter(m => !TOKENS_INTERNOS.includes(m?.trim()));

        if (filtered.length === 0) return null;
        if (filtered.length === 1) return filtered[0];

        try {
            const messagesText = filtered
                .map((m, i) => `Mensagem ${i + 1}: "${m}"`)
                .join('\n');

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        {
                            role: 'system',
                            content: `Voce e um interpretador de mensagens de WhatsApp de um escritorio de advocacia.
Pessoas frequentemente enviam varias mensagens curtas para expressar uma unica ideia.
Sua tarefa: analisar as mensagens em sequencia e sintetizar em UMA UNICA FRASE o que a pessoa realmente quer dizer.
IMPORTANTE: Use sempre "cliente" para se referir a pessoa. NUNCA use "paciente" — este e um escritorio de advocacia, nao uma clinica.
Responda APENAS com a sintese, sem explicacoes, sem aspas, sem prefixos.`
                        },
                        {
                            role: 'user',
                            content: `Estas mensagens foram enviadas em sequencia pela mesma pessoa:\n${messagesText}\n\nO que essa pessoa esta tentando dizer?`
                        }
                    ],
                    max_tokens: 150,
                    temperature: 0.2
                })
            });

            if (!response.ok) return filtered.join(' ');

            const data = await response.json();
            const sintese = data.choices[0].message.content.trim();

            logger.info('Intencao sintetizada', {
                original: filtered,
                sintese
            });

            return sintese;

        } catch (err) {
            logger.warn('Erro ao sintetizar intencao, usando mensagens originais', { error: err.message });
            return filtered.join(' ');
        }
    }

    /**
     * Extrai nome próprio de uma mensagem
     */
    async extractNameFromMessage(userMessage) {
        try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        {
                            role: 'system',
                            content: 'Extraia apenas o nome proprio da mensagem. Responda somente o nome, sem mais nada. Se nao houver nome claro, responda "null".'
                        },
                        { role: 'user', content: userMessage }
                    ],
                    max_tokens: 20,
                    temperature: 0.1
                })
            });
            if (!response.ok) return null;
            const data = await response.json();
            const extracted = data.choices[0].message.content.trim();
            if (extracted === 'null' || extracted.length < 2 || extracted.length > 60) return null;
            return extracted;
        } catch {
            return null;
        }
    }

    /**
     * Gera resposta da IA com contexto completo
     */
    async generateResponse(conversationId, userMessage, context = {}) {
        try {
            const startTime = Date.now();

            // Buscar dados do cliente e estado da conversa
            let clienteNome = 'Cliente';
            let clienteTelefone = '';
            let clienteId = null;
            let ultimoEstado = '';

            try {
                const clienteResult = await db.query(
                    `SELECT c.id, c.nome, c.telefone, conv.ultimo_estado
                     FROM conversations conv
                     JOIN clientes c ON conv.cliente_id = c.id
                     WHERE conv.id = $1`,
                    [conversationId]
                );
                if (clienteResult.rows.length > 0) {
                    clienteNome = clienteResult.rows[0].nome || 'Cliente';
                    clienteTelefone = clienteResult.rows[0].telefone || '';
                    clienteId = clienteResult.rows[0].id;
                    ultimoEstado = clienteResult.rows[0].ultimo_estado || '';
                }
                // pushName do WhatsApp tem prioridade — é o nome real do contato
                // Só cai para nome do banco quando pushName não estiver disponível
                if (context.pushName && context.pushName.trim()) {
                    clienteNome = context.pushName.trim();
                }
            } catch (dbError) {
                logger.warn('Erro ao buscar cliente', { error: dbError.message });
            }

            // Buscar as últimas 30 mensagens para contexto (aumentado de 15)
            const historyResult = await db.query(
                `SELECT sender, conteudo, timestamp
                 FROM messages
                 WHERE conversation_id = $1
                 ORDER BY timestamp DESC
                 LIMIT 30`,
                [conversationId]
            );
            const historico = historyResult.rows.reverse();

            // Log do histórico carregado
            logger.info('Historico carregado', {
                conversationId,
                totalMensagens: historico.length,
                primeiraMsg: historico[0]?.conteudo?.substring(0, 50),
                ultimaMsg: historico[historico.length - 1]?.conteudo?.substring(0, 50)
            });

            // Determinar se é primeira conversa
            const primeiraConversa = historico.length === 0 && this.isNomeGenerico(clienteNome);

            // Se estava aguardando nome, tenta extrair da mensagem atual
            if (ultimoEstado === 'aguardando_nome' && this.isNomeGenerico(clienteNome) && clienteId) {
                const nomeExtraido = await this.extractNameFromMessage(userMessage);
                if (nomeExtraido) {
                    clienteNome = nomeExtraido;
                    await db.query('UPDATE clientes SET nome = $1 WHERE id = $2', [nomeExtraido, clienteId]);
                    await db.query(
                        `UPDATE conversations SET ultimo_estado = 'nome_coletado' WHERE id = $1`,
                        [conversationId]
                    );
                    logger.info('Nome do cliente coletado', { clienteId, nome: nomeExtraido });
                }
            }

            // Pegar as últimas 3 mensagens do cliente para sintetizar intenção
            const ultimasMensagensCliente = historico
                .filter(m => m.sender === 'customer')
                .slice(-3)
                .map(m => m.conteudo);

            // Adicionar a mensagem atual
            ultimasMensagensCliente.push(userMessage);

            // Sintetizar intenção real (só quando há mais de 1 mensagem recente do cliente)
            let mensagemFinal = userMessage;
            if (ultimasMensagensCliente.length > 1) {
                const sintese = await this.synthesizeIntent(ultimasMensagensCliente);
                if (sintese && sintese !== userMessage) {
                    mensagemFinal = sintese;
                    logger.info('Usando intencao sintetizada para resposta', { 
                        original: userMessage,
                        sintese 
                    });
                }
            }

            // Montar mensagens para a IA
            // Se vier instrucaoEspecial no context (ex: transferência), usa ela no place do system prompt
            const systemContent = context.instrucaoEspecial
                ? `Você é o assistente virtual do ${process.env.COMPANY_NAME || 'Lopes Advocacia'}.

INSTRUÇÃO ESPECIAL:
${context.instrucaoEspecial}

Cliente: ${clienteNome}`
                : this.getSystemPrompt(clienteNome, clienteTelefone, primeiraConversa);

            const messages = [
                {
                    role: 'system',
                    content: systemContent
                }
            ];

            // Adicionar histórico completo para contexto
            // Mensagens 'system' com tipo 'image_context' são injetadas como notas para a IA
            historico.forEach(msg => {
                if (msg.sender === 'system' && msg.conteudo?.startsWith('[Conteúdo da imagem]')) {
                    // Injeta o conteúdo da imagem como nota do assistente para a IA ter contexto
                    messages.push({
                        role: 'assistant',
                        content: `📎 Nota interna: o cliente enviou uma imagem. ${msg.conteudo}`
                    });
                } else if (msg.sender !== 'system') {
                    messages.push({
                        role: msg.sender === 'customer' ? 'user' : 'assistant',
                        content: msg.conteudo
                    });
                }
            });

            // Adicionar intenção sintetizada como última mensagem
            messages.push({
                role: 'user',
                content: mensagemFinal
            });

            // Chamar Groq
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                    top_p: 1,
                    stream: false
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Groq API Error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const aiResponse = data.choices[0].message.content;
            const responseTime = Date.now() - startTime;

            // Marcar conversa como aguardando nome após primeira resposta
            if (primeiraConversa) {
                await db.query(
                    `UPDATE conversations SET ultimo_estado = 'aguardando_nome' WHERE id = $1`,
                    [conversationId]
                );
            }

            logger.info('Resposta gerada pela IA', {
                conversationId,
                cliente: clienteNome,
                primeiraConversa,
                mensagemOriginal: userMessage.substring(0, 60),
                mensagemSintetizada: mensagemFinal.substring(0, 60),
                responseTime: `${responseTime}ms`,
                tokensUsed: data.usage?.total_tokens || 0,
                saudacao: this.getSaudacao()
            });

            return {
                success: true,
                response: aiResponse,
                metadata: {
                    model: this.model,
                    tokensUsed: data.usage?.total_tokens || 0,
                    promptTokens: data.usage?.prompt_tokens || 0,
                    completionTokens: data.usage?.completion_tokens || 0,
                    responseTime,
                    saudacao: this.getSaudacao()
                }
            };

        } catch (error) {
            logger.error('Erro ao gerar resposta IA (Groq)', {
                error: error.message,
                conversationId,
                stack: error.stack
            });
            return {
                success: false,
                response: 'Desculpe, estou com dificuldades tecnicas no momento. Um de nossos advogados sera notificado e retornara em breve.',
                error: error.message
            };
        }
    }

    /**
     * Analisa sentimento da mensagem
     */
    analyzeSentiment(message) {
        const positiveWords = ['obrigado', 'otimo', 'excelente', 'perfeito', 'maravilha', 'adorei', 'bom', 'legal'];
        const negativeWords = ['ruim', 'pessimo', 'horrivel', 'problema', 'reclamar', 'insatisfeito', 'raiva', 'demora'];
        const lowerMsg = message.toLowerCase();
        const positiveCount = positiveWords.filter(w => lowerMsg.includes(w)).length;
        const negativeCount = negativeWords.filter(w => lowerMsg.includes(w)).length;
        if (positiveCount > negativeCount) return 'positive';
        if (negativeCount > positiveCount) return 'negative';
        return 'neutral';
    }

    /**
     * Detecta intenção da mensagem
     */
    detectIntent(message) {
        const lowerMsg = message.toLowerCase();
        const intents = {
            process_inquiry: ['processo', 'andamento', 'tramitacao', 'meu caso'],
            appointment: ['consulta', 'agendar', 'marcar', 'horario', 'atendimento'],
            urgency: ['urgente', 'emergencia', 'rapido', 'agora', 'importante'],
            new_case: ['novo caso', 'contratar', 'preciso de advogado', 'ajuda juridica'],
            complaint: ['reclamar', 'problema', 'insatisfeito', 'pessimo'],
            legal_issue: ['demissao', 'fgts', 'divorcio', 'guarda', 'pensao', 'inss', 'aposentadoria', 'contrato', 'divida']
        };
        for (const [intent, keywords] of Object.entries(intents)) {
            if (keywords.some(k => lowerMsg.includes(k))) return intent;
        }
        return 'general';
    }

    /**
     * Gera mensagem contextual via IA para situações específicas do sistema.
     * Substitui todas as mensagens hardcoded do webhook.
     * 
     * @param {string} situacao - Identificador da situação
     * @param {object} contexto - Dados disponíveis (clienteNome, historico, dados, etc.)
     * @returns {string} Mensagem gerada pela IA
     */
    async generateContextualMessage(situacao, contexto = {}) {
        const saudacao = this.getSaudacao();
        const nomeCliente = contexto.clienteNome || 'cliente';
        const companyName = process.env.COMPANY_NAME || 'Lopes Advocacia';
        const advogadoNome = 'Dr. Wanderson Mailson';
        const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/escritorio/consulta';

        const prompts = {

            // Documento recebido com sucesso
            documento_recebido: `Escreva uma mensagem CURTA (2-3 linhas) para o cliente "${nomeCliente}" confirmando que o documento "${contexto.filename || 'documento'}" foi recebido com sucesso.
Categoria identificada: ${contexto.categoria || 'documento jurídico'}.
${contexto.resumo ? `Resumo automático: ${contexto.resumo}` : 'Texto não pôde ser extraído automaticamente.'}
Informe que o ${advogadoNome} irá analisá-lo. Tom profissional e acolhedor.`,

            // Documento recebido mas com erro de leitura
            documento_recebido_sem_leitura: `Escreva uma mensagem CURTA (2-3 linhas) para o cliente "${nomeCliente}" dizendo que o documento foi recebido e salvo, mas não foi possível extrair o texto automaticamente. O ${advogadoNome} irá analisá-lo manualmente. Tom tranquilizador.`,

            // Erro ao baixar/processar mídia
            documento_erro_download: `Escreva uma mensagem CURTA (1-2 linhas) para o cliente "${nomeCliente}" dizendo que não conseguiu processar o arquivo enviado e pedindo para enviar novamente. Tom cordial.`,

            // Consulta processual - cliente sem processo cadastrado
            processo_novo_cliente: `Escreva uma mensagem para o cliente "${nomeCliente}" que perguntou sobre o andamento de um processo judicial mas ainda não é cadastrado no escritório ${companyName}.
Explique que para consultar processos o processo precisa estar vinculado ao escritório.
Ofereça duas opções:
1. Se já é cliente com processo, informar o número do processo
2. Se ainda não é cliente, iniciar um atendimento agora
Tom acolhedor. Máximo 5 linhas.`,

            // Consulta processual - número não encontrado no DataJud
            processo_nao_encontrado: `Escreva uma mensagem CURTA para o cliente "${nomeCliente}" dizendo que o processo número "${contexto.numeroProcesso || 'informado'}" não foi localizado no sistema do tribunal.
Sugira verificar se o número está correto ou entrar em contato com o ${advogadoNome}. Tom compreensivo.`,

            // Consulta processual - sem API configurada
            processo_sem_api: `Escreva uma mensagem CURTA para o cliente "${nomeCliente}" dizendo que o sistema de consultas processuais está temporariamente indisponível e que o ${advogadoNome} será notificado para retornar em breve. Tom tranquilizador.`,

            // Consulta processual - número sem formato válido
            processo_numero_invalido: `Escreva uma mensagem CURTA para o cliente "${nomeCliente}" explicando como informar corretamente o número do processo judicial.
Mostre o formato: 0001234-56.2024.8.10.0001
Ou apenas os 20 números seguidos. Tom didático e cordial.`,

            // Opt-out confirmado
            opt_out: `Escreva uma mensagem CURTA de despedida para o cliente "${nomeCliente}" que pediu para não receber mais mensagens.
Confirme que não enviaremos mais mensagens. Deixe a porta aberta caso precise de assistência jurídica no futuro. Tom respeitoso. Máximo 2 linhas.`,

            // Processo encontrado no DataJud - dados reais passados via webhook
            processo_encontrado_resumo: `Você recebeu os dados de um processo judicial. Apresente ao cliente "${nomeCliente}" as informações de forma clara, humana e profissional. Dados: ${contexto.dadosFormatados || ''}. Máximo 8 linhas. Tom acolhedor.`,

            // Cliente não sabe o número — processos já estão no banco
            processos_no_banco: `Escreva uma mensagem para o cliente "${nomeCliente}" listando os processos encontrados no cadastro do escritório.
Dados dos processos: ${JSON.stringify(contexto.processos || [])}.
Para cada processo, mostre o número, área/situação se disponível e última movimentação. Pergunte se deseja consultar algum deles. Tom cordial. Máximo 10 linhas.`,

            // Números encontrados nos documentos/emails/histórico
            numeros_encontrados_fontes: `Escreva uma mensagem para o cliente "${nomeCliente}" informando que encontrou número(s) de processo nas fontes internas (documentos, e-mails ou histórico).
Dados encontrados: ${JSON.stringify(contexto.numerosEncontrados || [])}.
Para cada número mostre a fonte onde foi encontrado (📄 documento, 📧 e-mail, 🕐 histórico). Pergunte se quer consultar. Tom entusiasmado e profissional. Máximo 10 linhas.`,

            // Processos encontrados no DataJud por nome do cliente
            processos_encontrados_datajud_nome: `Escreva uma mensagem para o cliente "${nomeCliente}" dizendo que não encontrou nas fontes internas, mas localizou processo(s) com o nome dele no tribunal (TJMA).
Dados encontrados: ${JSON.stringify(contexto.processosPorNome || [])}.
Mostre os dados de cada processo e pergunte se é dele para registrar e acompanhar. Tom cauteloso e profissional. Máximo 10 linhas.`,

            // Nenhuma fonte encontrou o número
            processo_nao_encontrado_fontes: `Escreva uma mensagem para o cliente "${nomeCliente}" explicando que pesquisou nos documentos, e-mails e histórico do escritório mas não encontrou o número do processo.
Sugira verificar no site do TJMA (tjma.jus.br → Consulta Processual → buscar pelo nome). Diga que assim que tiver o número basta enviar no formato 0001234-56.2024.8.10.0001. Tom compreensivo e prestativo. Máximo 6 linhas.`,
            erro_ia: `Escreva uma mensagem MUITO CURTA (1-2 linhas) para o cliente "${nomeCliente}" dizendo que houve uma instabilidade momentânea e que o ${advogadoNome} será notificado. Tom profissional.`,

            // Comando #email sem permissão (só para o advogado ver no log — nunca chega ao cliente)
            sem_permissao_email: `Escreva uma mensagem CURTA informando que o comando de e-mail não está disponível para este número. Tom neutro.`,
        };

        const promptTexto = prompts[situacao];
        if (!promptTexto) {
            logger.warn('generateContextualMessage: situacao desconhecida', { situacao });
            return `Olá${nomeCliente !== 'cliente' ? ', ' + nomeCliente : ''}! Aguarde um momento enquanto verificamos sua solicitação.`;
        }

        try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        {
                            role: 'system',
                            content: `Você é o assistente virtual do escritório de advocacia ${companyName}.
O advogado responsável é o ${advogadoNome}.
REGRAS: Respostas curtas e objetivas. Tom ${process.env.AI_TONE || 'formal'} e acolhedor.
Saudação atual: ${saudacao}.
NUNCA use apenas "Olá" — use sempre a saudação correta por horário.
NUNCA invente informações jurídicas específicas.`
                        },
                        { role: 'user', content: promptTexto }
                    ],
                    max_tokens: 200,
                    temperature: 0.5
                })
            });

            if (!response.ok) throw new Error(`Groq HTTP ${response.status}`);

            const data = await response.json();
            const mensagem = data.choices[0].message.content.trim();

            logger.info('Mensagem contextual gerada', { situacao, clienteNome: nomeCliente, length: mensagem.length });
            return mensagem;

        } catch (err) {
            logger.error('Erro ao gerar mensagem contextual', { situacao, error: err.message });
            // Fallback mínimo — nunca retorna string vazia
            const fallbacks = {
                documento_recebido: `${saudacao}, ${nomeCliente}! Seu documento foi recebido com sucesso. O ${advogadoNome} irá analisá-lo em breve.`,
                documento_recebido_sem_leitura: `${saudacao}, ${nomeCliente}! Documento recebido e salvo. O ${advogadoNome} irá analisá-lo manualmente.`,
                documento_erro_download: `Não consegui processar o arquivo. Poderia enviá-lo novamente?`,
                processo_novo_cliente: `${saudacao}, ${nomeCliente}! Para consultar processos, preciso que estejam vinculados ao nosso escritório. Informe o número do processo ou descreva sua necessidade.`,
                processo_nao_encontrado: `Não localizei o processo informado. Verifique o número ou entre em contato com o ${advogadoNome}.`,
                processo_sem_api: `O sistema de consultas está temporariamente indisponível. O ${advogadoNome} entrará em contato em breve.`,
                processo_numero_invalido: `Para consultar, informe o número do processo no formato: 0001234-56.2024.8.10.0001`,
                opt_out: `Entendido! Não enviaremos mais mensagens. Estamos à disposição sempre que precisar.`,
                erro_ia: `Houve uma instabilidade momentânea. O ${advogadoNome} será notificado.`,
                sem_permissao_email: `Comando não disponível para este número.`,
            };
            return fallbacks[situacao] || `${saudacao}! Aguarde um momento.`;
        }
    }

    /**
     * Testa conexão com Groq API
     */
    async testConnection() {
        try {
            const response = await fetch('https://api.groq.com/openai/v1/models', {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            if (response.ok) {
                logger.info('Groq API conectada com sucesso!');
                return true;
            }
            logger.error('Falha ao conectar com Groq API');
            return false;
        } catch (error) {
            logger.error('Erro ao testar Groq API', { error: error.message });
            return false;
        }
    }
}

module.exports = new GroqAIService();