const logger = require('../utils/logger');
const db = require('./database');

/**
 * Coletor Inteligente de Informações para Novos Processos
 * Extrai dados estruturados de conversas com clientes
 */

class NewCaseCollector {
    constructor() {
        // Campos essenciais a coletar
        this.requiredFields = [
            'area_direito',      // Trabalhista, Família, etc
            'descricao_resumida', // Breve descrição do caso
            'nome_completo',     // Nome do cliente
            'telefone',          // Telefone
            'email'              // E-mail (opcional)
        ];

        // Campos adicionais por área do direito
        this.areaSpecificFields = {
            trabalhista: ['empresa', 'data_demissao', 'motivo_demissao', 'valor_estimado'],
            familia: ['tipo_acao', 'outro_envolvido', 'tem_filhos', 'bens_comuns'],
            consumidor: ['empresa_reclamada', 'produto_servico', 'data_problema', 'valor_pago'],
            criminal: ['tipo_crime', 'data_fato', 'tem_bo', 'numero_bo'],
            previdenciario: ['tipo_beneficio', 'idade', 'tempo_contribuicao', 'ja_indeferido'],
            civel: ['tipo_acao', 'valor_causa', 'tem_documentos', 'urgente']
        };
    }

    /**
     * Identifica área do direito da mensagem usando IA
     */
    async identifyLegalArea(message) {
        try {
            const prompt = `Identifique a área do direito desta mensagem. Responda APENAS com uma das opções:
trabalhista, familia, consumidor, criminal, previdenciario, civel, ou "indefinido"

Mensagem: ${message}

Resposta:`;

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 20,
                    temperature: 0.1
                })
            });

            if (!response.ok) throw new Error('Groq API error');

            const data = await response.json();
            const area = data.choices[0].message.content.trim().toLowerCase();

            const validAreas = ['trabalhista', 'familia', 'consumidor', 'criminal', 'previdenciario', 'civel'];
            return validAreas.includes(area) ? area : 'indefinido';

        } catch (error) {
            logger.error('Erro ao identificar área do direito', { error: error.message });
            return 'indefinido';
        }
    }

    /**
     * Extrai informações estruturadas da conversa usando IA
     */
    async extractInformation(conversationHistory, area = null) {
        try {
            // Montar contexto da conversa
            const conversationText = conversationHistory
                .map(msg => `${msg.sender === 'customer' ? 'Cliente' : 'Assistente'}: ${msg.conteudo}`)
                .join('\n');

            const fieldsToExtract = area && this.areaSpecificFields[area] 
                ? [...this.requiredFields, ...this.areaSpecificFields[area]]
                : this.requiredFields;

            const prompt = `Analise esta conversa e extraia as seguintes informações em formato JSON:

${fieldsToExtract.map(field => `- ${field}`).join('\n')}

Conversa:
${conversationText}

Responda APENAS com JSON válido (sem markdown):
{
  "area_direito": "",
  "descricao_resumida": "",
  "nome_completo": "",
  "telefone": "",
  "email": "",
  ${area ? fieldsToExtract.filter(f => !this.requiredFields.includes(f)).map(f => `"${f}": ""`).join(',\n  ') : ''}
  "informacoes_completas": true/false
}

Se alguma informação não foi mencionada, deixe vazio. Marque "informacoes_completas" como true apenas se TODOS os campos obrigatórios foram preenchidos.`;

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 500,
                    temperature: 0.2
                })
            });

            if (!response.ok) throw new Error('Groq API error');

            const data = await response.json();
            const text = data.choices[0].message.content.trim();
            const clean = text.replace(/```json|```/g, '').trim();
            
            return JSON.parse(clean);

        } catch (error) {
            logger.error('Erro ao extrair informações', { error: error.message });
            return null;
        }
    }

    /**
     * Identifica qual informação está faltando
     */
    getMissingFields(extractedData, area) {
        const fieldsToCheck = area && this.areaSpecificFields[area]
            ? [...this.requiredFields, ...this.areaSpecificFields[area]]
            : this.requiredFields;

        const missing = fieldsToCheck.filter(field => 
            !extractedData[field] || extractedData[field].trim() === ''
        );

        return missing;
    }

    /**
     * Gera próxima pergunta para coletar informação faltante
     */
    async generateNextQuestion(missingField, area, extractedData) {
        const fieldQuestions = {
            area_direito: 'Qual é a área do seu caso? (Trabalhista, Família, Consumidor, Criminal, Previdenciário ou Cível)',
            descricao_resumida: 'Por favor, descreva brevemente o seu caso.',
            nome_completo: 'Para prosseguir, preciso do seu nome completo.',
            telefone: 'Qual é o seu telefone de contato?',
            email: 'Qual é o seu e-mail? (opcional)',
            
            // Trabalhista
            empresa: 'Qual era o nome da empresa onde você trabalhava?',
            data_demissao: 'Quando foi a data da sua demissão?',
            motivo_demissao: 'Qual foi o motivo alegado para a demissão?',
            valor_estimado: 'Você tem ideia de quanto espera receber?',
            
            // Família
            tipo_acao: 'Que tipo de ação você precisa? (divórcio, guarda, pensão, etc)',
            outro_envolvido: 'Qual o nome da outra parte envolvida?',
            tem_filhos: 'Vocês têm filhos menores?',
            bens_comuns: 'Existem bens em comum a serem partilhados?',
            
            // Consumidor
            empresa_reclamada: 'Qual empresa ou estabelecimento você quer reclamar?',
            produto_servico: 'Qual produto ou serviço está em questão?',
            data_problema: 'Quando ocorreu o problema?',
            valor_pago: 'Qual foi o valor pago?',
            
            // Criminal
            tipo_crime: 'Qual é a natureza do caso?',
            data_fato: 'Quando ocorreu o fato?',
            tem_bo: 'Já foi registrado Boletim de Ocorrência?',
            numero_bo: 'Qual é o número do BO?',
            
            // Previdenciário
            tipo_beneficio: 'Que tipo de benefício você busca? (aposentadoria, auxílio-doença, etc)',
            idade: 'Qual é a sua idade?',
            tempo_contribuicao: 'Há quanto tempo você contribui para o INSS?',
            ja_indeferido: 'Já teve algum pedido negado anteriormente?',
            
            // Cível
            valor_causa: 'Qual é o valor envolvido no caso?',
            tem_documentos: 'Você possui documentos relacionados ao caso?',
            urgente: 'Este caso tem algum prazo urgente?'
        };

        return fieldQuestions[missingField] || `Preciso saber sobre: ${missingField}`;
    }

    /**
     * Salva caso parcial no banco (rascunho)
     */
    async saveDraftCase(conversationId, extractedData) {
        try {
            const result = await db.query(
                `INSERT INTO casos_em_coleta (
                    conversation_id,
                    area_direito,
                    dados_coletados,
                    ultima_atualizacao,
                    status
                ) VALUES ($1, $2, $3, NOW(), 'em_coleta')
                ON CONFLICT (conversation_id)
                DO UPDATE SET 
                    dados_coletados = $3,
                    ultima_atualizacao = NOW()
                RETURNING id`,
                [conversationId, extractedData.area_direito || 'indefinido', JSON.stringify(extractedData)]
            );

            logger.info('Caso parcial salvo', { 
                conversationId,
                casoId: result.rows[0].id 
            });

            return result.rows[0].id;

        } catch (error) {
            logger.error('Erro ao salvar caso parcial', { 
                error: error.message,
                conversationId 
            });
            return null;
        }
    }

    /**
     * Finaliza e cria caso completo
     */
    async finalizeCase(conversationId, extractedData) {
        try {
            // Criar cliente se não existir
            let clienteId;
            const clienteResult = await db.query(
                `SELECT id FROM clientes WHERE telefone = $1`,
                [extractedData.telefone]
            );

            if (clienteResult.rows.length > 0) {
                clienteId = clienteResult.rows[0].id;
                
                // Atualizar dados
                await db.query(
                    `UPDATE clientes SET 
                        nome = $1,
                        email = $2,
                        updated_at = NOW()
                     WHERE id = $3`,
                    [extractedData.nome_completo, extractedData.email || null, clienteId]
                );
            } else {
                const insertResult = await db.query(
                    `INSERT INTO clientes (nome, telefone, email, created_at)
                     VALUES ($1, $2, $3, NOW())
                     RETURNING id`,
                    [extractedData.nome_completo, extractedData.telefone, extractedData.email || null]
                );
                clienteId = insertResult.rows[0].id;
            }

            // Criar processo
            const processoResult = await db.query(
                `INSERT INTO processos (
                    cliente_id,
                    area_direito,
                    descricao,
                    dados_iniciais,
                    status,
                    created_at
                ) VALUES ($1, $2, $3, $4, 'triagem', NOW())
                RETURNING id`,
                [
                    clienteId,
                    extractedData.area_direito,
                    extractedData.descricao_resumida,
                    JSON.stringify(extractedData)
                ]
            );

            // Marcar caso em coleta como finalizado
            await db.query(
                `UPDATE casos_em_coleta 
                 SET status = 'finalizado', processo_id = $1
                 WHERE conversation_id = $2`,
                [processoResult.rows[0].id, conversationId]
            );

            logger.info('Caso finalizado e processo criado', {
                conversationId,
                clienteId,
                processoId: processoResult.rows[0].id
            });

            return {
                processoId: processoResult.rows[0].id,
                clienteId
            };

        } catch (error) {
            logger.error('Erro ao finalizar caso', { 
                error: error.message,
                conversationId 
            });
            throw error;
        }
    }

    /**
     * Processa conversa e retorna próxima ação
     */
    async processConversation(conversationId, conversationHistory) {
        logger.info('Processando conversa para coleta de caso', { conversationId });

        // 1. Extrair informações da conversa
        const extracted = await this.extractInformation(conversationHistory);
        
        if (!extracted) {
            return {
                action: 'error',
                message: 'Não consegui processar as informações. Pode reformular?'
            };
        }

        // 2. Identificar área se ainda não identificada
        if (!extracted.area_direito || extracted.area_direito === 'indefinido') {
            const lastMessage = conversationHistory[conversationHistory.length - 1]?.conteudo || '';
            extracted.area_direito = await this.identifyLegalArea(lastMessage);
        }

        // 3. Salvar rascunho
        await this.saveDraftCase(conversationId, extracted);

        // 4. Verificar se está completo
        const missing = this.getMissingFields(extracted, extracted.area_direito);

        if (missing.length === 0) {
            // Caso completo - finalizar
            const result = await this.finalizeCase(conversationId, extracted);
            
            return {
                action: 'complete',
                message: `Perfeito! Registrei seu caso e já vou encaminhar para nossa equipe. ` +
                        `Em breve, um advogado especializado em ${this.formatAreaName(extracted.area_direito)} ` +
                        `entrará em contato. Seu número de protocolo é ${result.processoId}. ✅`,
                data: result
            };
        }

        // 5. Pedir próxima informação
        const nextField = missing[0];
        const nextQuestion = await this.generateNextQuestion(nextField, extracted.area_direito, extracted);

        return {
            action: 'collect',
            message: nextQuestion,
            missing: missing,
            progress: {
                collected: Object.keys(extracted).filter(k => extracted[k] && extracted[k] !== '').length,
                total: this.requiredFields.length + (this.areaSpecificFields[extracted.area_direito]?.length || 0)
            }
        };
    }

    /**
     * Formata nome da área para exibição
     */
    formatAreaName(area) {
        const names = {
            trabalhista: 'Direito Trabalhista',
            familia: 'Direito de Família',
            consumidor: 'Direito do Consumidor',
            criminal: 'Direito Criminal',
            previdenciario: 'Direito Previdenciário',
            civel: 'Direito Cível'
        };
        return names[area] || area;
    }
}

module.exports = new NewCaseCollector();