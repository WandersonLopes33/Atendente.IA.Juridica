const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const db = require('./database');

// ── PATCH 1: imports no topo — evita "pdfParse is not a function" ─────────────
// require() dentro de método async pode retornar objeto em vez da função
let pdfParse;
try {
    pdfParse = require('pdf-parse');
    // Alguns bundles exportam como .default
    if (typeof pdfParse !== 'function' && pdfParse.default) {
        pdfParse = pdfParse.default;
    }
} catch (e) {
    logger.warn('pdf-parse não instalado — PDFs não serão lidos', { error: e.message });
}

let mammoth;
try {
    mammoth = require('mammoth');
} catch (e) {
    logger.warn('mammoth não instalado — DOCX não serão lidos', { error: e.message });
}

/**
 * Leitor e Processador de Documentos
 * Suporta PDF, DOCX, TXT, imagens (OCR) e salva no sistema
 */

class DocumentProcessor {
    constructor() {
        this.supportedFormats = ['.pdf', '.docx', '.doc', '.txt', '.jpg', '.jpeg', '.png'];
        this.documentsPath = process.env.DOCUMENTS_PATH || path.join(__dirname, '..', 'documents');
        this.maxFileSize = parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024; // 10MB

        // ── PATCH 3+4: categorias reordenadas (mais específicas primeiro) ─────
        // Ordem importa: a primeira categoria que bater ganha
        // Peticao/sentença/acao ANTES de contrato (que tem keyword 'acordo')
        this.documentCategories = {
            // Documentos processuais — mais específicos, verificar primeiro
            'peticao':   ['peticao', 'excelentissimo', 'requer', 'inicial', 'contestacao',
                          'acao de', 'cumprimento', 'tutela', 'liminar', 'recurso'],
            'sentenca':  ['sentenca', 'julgo', 'dispositivo', 'acordao', 'decisao judicial',
                          'improcedente', 'procedente'],

            // Documentos de identidade — keywords longas primeiro, 'rg' isolado por último
            'rg':        ['registro geral', 'doc de identidade', 'documento de identidade',
                          'carteira de identidade', 'identidade civil'],
            'cpf':       ['cadastro de pessoas fisicas', 'receita federal', ' cpf '],

            // Trabalhistas
            'ctps':      ['carteira de trabalho', 'ctps', 'previdencia social',
                          'trabalho e previdencia'],
            'extrato':   ['extrato bancario', 'extrato fgts', 'extrato do fgts',
                          'saldo fgts', 'movimentacao financeira', 'fgts', 'saldo bancario'],

            // Contratuais — 'acordo' e 'contrato' DEPOIS dos processuais
            'contrato':  ['contrato de', 'clausula', 'partes contratantes',
                          'rescisao contratual', 'distrato'],
            'procuracao':['procuracao', 'outorga poderes', 'mandato', 'substabelecimento'],

            // Pessoais/civis
            'certidao':  ['certidao de nascimento', 'certidao de casamento',
                          'certidao de obito', 'registro civil', 'cartorio'],
            'comprovante_residencia': ['comprovante de residencia', 'comprovante de endereco',
                                       'conta de luz', 'conta de agua', 'conta de energia',
                                       'boleto residencial'],

            // Médicos/periciais
            'laudo':     ['laudo medico', 'laudo pericial', 'pericia medica',
                          'relatorio medico', 'atestado medico', 'cid '],
            'recibo':    ['recibo de pagamento', 'valor recebido', 'quitacao'],

            'outros':    []
        };
    }

    // ── PATCH 2: normalização de acentos + word boundary ─────────────────────
    /**
     * Remove acentos para comparação case-insensitive sem erros de encoding
     */
    normalizeText(text) {
        return text
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
    }

    /**
     * Verifica se keyword está presente no texto
     * Keywords curtas (≤4 chars): exige isolamento (não pode ser substring de outra palavra)
     * Keywords longas: substring normal após normalização
     */
    hasKeyword(text, keyword) {
        const normText = this.normalizeText(text);
        const normKw   = this.normalizeText(keyword);

        if (normKw.length <= 4) {
            // Word boundary: não pode ter letra antes ou depois
            const pattern = new RegExp('(?<![a-z])' + normKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z])');
            return pattern.test(normText);
        }

        return normText.includes(normKw);
    }

    /**
     * Inicializa diretórios necessários
     */
    async initialize() {
        try {
            await fs.mkdir(this.documentsPath, { recursive: true });
            await fs.mkdir(path.join(this.documentsPath, 'processos'), { recursive: true });
            await fs.mkdir(path.join(this.documentsPath, 'clientes'), { recursive: true });
            await fs.mkdir(path.join(this.documentsPath, 'temp'), { recursive: true });
            
            logger.info('Diretórios de documentos inicializados', { path: this.documentsPath });
        } catch (error) {
            logger.error('Erro ao criar diretórios', { error: error.message });
        }
    }

    /**
     * Valida arquivo recebido
     */
    validateFile(filename, filesize) {
        const ext = path.extname(filename).toLowerCase();

        if (!this.supportedFormats.includes(ext)) {
            return {
                valid: false,
                reason: `Formato não suportado. Aceito: ${this.supportedFormats.join(', ')}`
            };
        }

        if (filesize > this.maxFileSize) {
            return {
                valid: false,
                reason: `Arquivo muito grande. Máximo: ${this.maxFileSize / (1024 * 1024)}MB`
            };
        }

        return { valid: true };
    }

    /**
     * Baixa e descriptografa arquivo do WhatsApp via Evolution API
     *
     * A URL que vem no payload do WhatsApp é encriptada — não pode ser
     * baixada diretamente. A Evolution API expõe o endpoint
     * POST /chat/getBase64FromMediaMessage/{instance}
     * que faz o download + descriptografia e retorna base64 limpo.
     *
     * Fallback: se o endpoint falhar, tenta baixar a URL direta
     * (funciona quando a Evolution já salva o arquivo localmente).
     */
    async downloadFromWhatsApp(mediaUrl, filename, messageId = null) {
        const tempPath = path.join(this.documentsPath, 'temp', filename);

        // ── Tentativa 1: Evolution API base64 endpoint (correto para mídia WA) ──
        try {
            const evolutionBase = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
            const evolutionInstance = process.env.EVOLUTION_INSTANCE || 'Juridico';
            const evolutionKey = process.env.EVOLUTION_API_KEY || '';

            // Endpoint aceita messageId ou url diretamente
            const payload = messageId
                ? { messageId, convertToMp4: false }
                : { url: mediaUrl, convertToMp4: false };

            const response = await fetch(
                `${evolutionBase}/chat/getBase64FromMediaMessage/${evolutionInstance}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': evolutionKey
                    },
                    body: JSON.stringify(payload)
                }
            );

            if (response.ok) {
                const data = await response.json();
                const base64Data = data?.base64 || data?.data?.base64 || data?.mediaData?.base64;

                if (base64Data) {
                    // Remove prefixo data:image/jpeg;base64, se existir
                    const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');
                    const buffer = Buffer.from(cleanBase64, 'base64');
                    await fs.writeFile(tempPath, buffer);

                    logger.info('Arquivo baixado via Evolution base64', {
                        filename,
                        size: buffer.length
                    });
                    return tempPath;
                }
            }

            logger.warn('Evolution base64 endpoint não retornou dados — tentando URL direta', {
                filename, status: response.status
            });

        } catch (err) {
            logger.warn('Erro no endpoint Evolution base64 — tentando URL direta', {
                error: err.message, filename
            });
        }

        // ── Tentativa 2: URL direta (funciona quando Evolution salva localmente) ──
        try {
            const response = await fetch(mediaUrl);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const buffer = await response.arrayBuffer();
            await fs.writeFile(tempPath, Buffer.from(buffer));

            logger.info('Arquivo baixado via URL direta', {
                filename,
                size: buffer.byteLength
            });

            return tempPath;

        } catch (error) {
            logger.error('Falha total ao baixar arquivo do WhatsApp', {
                error: error.message,
                mediaUrl,
                filename
            });
            throw error;
        }
    }

    /**
     * Extrai texto de PDF — usa pdfParse importado no topo
     */
    async extractTextFromPDF(filePath) {
        try {
            if (!pdfParse) {
                throw new Error('pdf-parse não está instalado. Execute: npm install pdf-parse');
            }

            const dataBuffer = await fs.readFile(filePath);
            const data = await pdfParse(dataBuffer);

            return {
                text: data.text,
                pages: data.numpages,
                metadata: data.info
            };

        } catch (error) {
            logger.error('Erro ao extrair texto do PDF', { 
                error: error.message,
                filePath 
            });
            return { text: '', pages: 0, metadata: null };
        }
    }

    /**
     * Extrai texto de DOCX — usa mammoth importado no topo
     */
    async extractTextFromDOCX(filePath) {
        try {
            if (!mammoth) {
                throw new Error('mammoth não está instalado. Execute: npm install mammoth');
            }

            const result = await mammoth.extractRawText({ path: filePath });

            return {
                text: result.value,
                messages: result.messages
            };

        } catch (error) {
            logger.error('Erro ao extrair texto do DOCX', { 
                error: error.message,
                filePath 
            });
            return { text: '', messages: [] };
        }
    }

    /**
     * Analisa imagem com Groq Vision (llama-4-scout-17b-16e-instruct)
     * Retorna descrição completa do conteúdo — documentos, fotos, intimações, etc.
     */
    async analyzeImageWithVision(filePath, caption = '') {
        try {
            if (!process.env.GROQ_API_KEY) {
                logger.warn('GROQ_API_KEY não configurada — Vision não disponível');
                return null;
            }

            // Ler arquivo e verificar se é válido
            let imageBuffer = await fs.readFile(filePath);

            if (!imageBuffer || imageBuffer.length < 100) {
                logger.warn('Vision: arquivo muito pequeno ou vazio', { filePath, size: imageBuffer?.length });
                return null;
            }

            // Reencoder para JPEG via sharp — garante formato válido independente do que chegou do WhatsApp
            // (imagens do Evolution API às vezes chegam com header corrompido ou em formato não-padrão)
            let mimeType = 'image/jpeg';
            try {
                const sharp = require('sharp');
                imageBuffer = await sharp(imageBuffer)
                    .jpeg({ quality: 85 })
                    .toBuffer();
                mimeType = 'image/jpeg';
                logger.info('Vision: imagem reencodada via sharp', { 
                    filePath: path.basename(filePath),
                    newSize: imageBuffer.length 
                });
            } catch (sharpErr) {
                logger.warn('Vision: sharp falhou, usando buffer original', { error: sharpErr.message });
                // Detectar mime type pelo magic bytes como fallback
                if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50) mimeType = 'image/png';
                else if (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8) mimeType = 'image/jpeg';
            }

            const base64Image = imageBuffer.toString('base64');

            logger.info('Vision: enviando imagem para análise', {
                filePath: path.basename(filePath),
                size: imageBuffer.length,
                mimeType,
                hasCaption: !!caption
            });

            const systemPrompt = `Você é um assistente especializado em análise de imagens para um escritório de advocacia.
Ao receber uma imagem, analise e descreva:
1. O que é a imagem (tipo de documento, foto, print, etc.)
2. O conteúdo principal (texto visível, informações importantes)
3. Se for documento jurídico: tipo, partes envolvidas, número de processo, datas, valores
4. Se for foto de situação: descreva o contexto relevante juridicamente
Seja objetivo e completo. Responda em português.`;

            const userContent = [];
            if (caption) {
                userContent.push({ type: 'text', text: `O cliente enviou esta imagem com a seguinte mensagem: "${caption}"\nDescreva o conteúdo da imagem:` });
            } else {
                userContent.push({ type: 'text', text: 'Descreva detalhadamente o conteúdo desta imagem:' });
            }
            userContent.push({
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Image}` }
            });

            const VISION_MODELS = [
                'meta-llama/llama-4-scout-17b-16e-instruct',
                'llama-3.2-11b-vision-preview',
                'llama-3.2-90b-vision-preview'
            ];

            let response = null;
            let modelUsado = null;

            for (const model of VISION_MODELS) {
                try {
                    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                        },
                        body: JSON.stringify({
                            model,
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: userContent }
                            ],
                            max_tokens: 1000,
                            temperature: 0.1
                        })
                    });

                    if (response.ok) {
                        modelUsado = model;
                        break;
                    }

                    const errBody = await response.text();
                    logger.warn('Groq Vision modelo falhou, tentando próximo', {
                        model, status: response.status, body: errBody.substring(0, 200)
                    });
                    response = null;

                } catch (fetchErr) {
                    logger.warn('Erro de fetch no modelo Vision', { model, error: fetchErr.message });
                }
            }

            if (!response || !response.ok) {
                logger.warn('Vision: todos os modelos falharam');
                return null;
            }

            logger.info('Vision: usando modelo', { model: modelUsado });

            const data = await response.json();
            const descricao = data.choices?.[0]?.message?.content?.trim();

            if (descricao) {
                logger.info('Vision: imagem analisada com sucesso', {
                    filePath: path.basename(filePath),
                    descricaoLength: descricao.length
                });
                return descricao;
            }

            return null;

        } catch (error) {
            logger.error('Erro ao analisar imagem com Vision', { error: error.message, filePath });
            return null;
        }
    }

    /**
     * Extrai texto de imagem (OCR) — fallback quando Vision não está disponível
     * Usa timeout e Promise wrapper para evitar que exceções do Worker
     * vazem para o processo principal e derrubem o servidor
     */
    async extractTextFromImage(filePath) {
        return new Promise((resolve) => {
            const TIMEOUT_MS = 30000; // 30s máximo para OCR

            const timer = setTimeout(() => {
                logger.warn('OCR timeout — imagem ignorada', { filePath });
                resolve({ text: '' });
            }, TIMEOUT_MS);

            const runOCR = async () => {
                try {
                    const Tesseract = require('tesseract.js');
                    const { data: { text } } = await Tesseract.recognize(
                        filePath,
                        'por',
                        { logger: () => {} } // Silenciar logs de progresso
                    );
                    clearTimeout(timer);
                    resolve({ text: text || '' });
                } catch (error) {
                    clearTimeout(timer);
                    logger.error('Erro ao extrair texto da imagem (OCR)', {
                        error: error.message,
                        filePath
                    });
                    resolve({ text: '' }); // Nunca rejeita — retorna vazio
                }
            };

            runOCR();
        });
    }

    /**
     * Processa documento e extrai texto
     */
    async processDocument(filePath, caption = '') {
        const ext = path.extname(filePath).toLowerCase();

        switch (ext) {
            case '.pdf':
                return await this.extractTextFromPDF(filePath);
            case '.docx':
            case '.doc':
                return await this.extractTextFromDOCX(filePath);
            case '.txt':
                const text = await fs.readFile(filePath, 'utf-8');
                return { text };
            case '.jpg':
            case '.jpeg':
            case '.png':
            case '.webp': {
                // Tenta Vision primeiro (mais preciso para fotos e documentos fotografados)
                const visionText = await this.analyzeImageWithVision(filePath, caption);
                if (visionText && visionText.length > 20) {
                    logger.info('Imagem processada via Vision', { filePath: path.basename(filePath) });
                    return { text: visionText, viaVision: true };
                }
                // Fallback: OCR para imagens com texto limpo
                logger.info('Vision indisponível/sem resultado — tentando OCR', { filePath: path.basename(filePath) });
                const ocrResult = await this.extractTextFromImage(filePath);
                return { ...ocrResult, viaVision: false };
            }
            default:
                throw new Error(`Formato não suportado: ${ext}`);
        }
    }

    /**
     * Categoriza documento automaticamente
     * PATCH 2+3+4: usa normalização + word boundary + ordem correta
     */
    async categorizeDocument(text, filename) {
        for (const [category, keywords] of Object.entries(this.documentCategories)) {
            if (category === 'outros') continue;

            const matchedKw = keywords.find(kw =>
                this.hasKeyword(text, kw) || this.hasKeyword(filename, kw)
            );

            if (matchedKw) {
                logger.info('Categoria identificada por keywords', { 
                    filename, 
                    category,
                    matchedKeyword: matchedKw
                });
                return category;
            }
        }

        // Se não encontrou por keyword, tenta IA
        if (process.env.GROQ_API_KEY && text.length > 50) {
            logger.info('Keywords não identificaram — tentando com IA', { filename });
            const aiCategory = await this.categorizeWithAI(text, filename);
            if (aiCategory && aiCategory !== 'outros') {
                return aiCategory;
            }
        }

        logger.info('Categoria não identificada — usando "outros"', { filename });
        return 'outros';
    }

    /**
     * Categoriza com IA quando keywords não funcionam
     */
    async categorizeWithAI(text, filename) {
        try {
            const categoriesList = Object.keys(this.documentCategories)
                .filter(c => c !== 'outros')
                .join(', ');

            const prompt = `Classifique este documento jurídico em UMA das categorias:
${categoriesList}

NOME DO ARQUIVO: ${filename}

CONTEÚDO (primeiras linhas):
${text.substring(0, 1000)}

Responda APENAS com o nome da categoria (uma palavra), nada mais.`;

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                    messages: [
                        { 
                            role: 'system', 
                            content: 'Você classifica documentos. Responda apenas com o nome da categoria.' 
                        },
                        { role: 'user', content: prompt }
                    ],
                    max_tokens: 20,
                    temperature: 0.1
                })
            });

            if (!response.ok) throw new Error('Groq API error');

            const data = await response.json();
            const category = data.choices[0].message.content.trim().toLowerCase();

            if (Object.keys(this.documentCategories).includes(category)) {
                logger.info('Categoria identificada via IA', { filename, category });
                return category;
            }

            return 'outros';

        } catch (error) {
            logger.error('Erro ao categorizar com IA', { error: error.message });
            return 'outros';
        }
    }

    /**
     * Analisa documento com IA
     */
    async analyzeDocument(text, filename) {
        try {
            // Se não extraiu texto, não tem como analisar
            if (!text || text.trim().length < 20) {
                return {
                    tipo: path.extname(filename).replace('.', '').toUpperCase(),
                    resumo: 'Texto não extraído — documento salvo para análise manual',
                    informacoes_importantes: [],
                    numero_processo: ''
                };
            }

            const prompt = `Analise este documento jurídico e forneça:
1. Tipo de documento (petição, contrato, certidão, etc)
2. Resumo em 2-3 linhas
3. Informações importantes encontradas
4. Se contém número de processo

Documento: ${filename}
Conteúdo: ${text.substring(0, 3000)}

Responda em JSON:
{
  "tipo": "",
  "resumo": "",
  "informacoes_importantes": [],
  "numero_processo": ""
}`;

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
            const text_response = data.choices[0].message.content.trim();
            const clean = text_response.replace(/```json|```/g, '').trim();
            
            return JSON.parse(clean);

        } catch (error) {
            logger.error('Erro ao analisar documento com IA', { error: error.message });
            return {
                tipo: 'Desconhecido',
                resumo: 'Não foi possível analisar automaticamente',
                informacoes_importantes: [],
                numero_processo: ''
            };
        }
    }

    /**
     * Mensagem de confirmação personalizada por categoria
     */
    getConfirmationMessage(categoria, resumo) {
        const messages = {
            'ctps':                   '📄 CTPS recebida e salva! Documento importante para caso trabalhista.',
            'rg':                     '🪪 RG recebido e arquivado! Documento de identificação registrado.',
            'cpf':                    '📋 CPF recebido! Documento cadastral salvo.',
            'comprovante_residencia': '🏠 Comprovante de residência recebido e arquivado!',
            'certidao':               '📜 Certidão recebida e registrada!',
            'contrato':               '📑 Contrato recebido e salvo! Vamos analisar os termos.',
            'procuracao':             '⚖️ Procuração recebida e arquivada!',
            'peticao':                '📋 Petição/Ação recebida! Documento processual registrado.',
            'sentenca':               '⚖️ Sentença/Decisão recebida e salva!',
            'recibo':                 '🧾 Recibo recebido e arquivado!',
            'extrato':                '💰 Extrato recebido! Documento financeiro registrado.',
            'laudo':                  '⚕️ Laudo recebido e arquivado! Documento pericial salvo.',
            'outros':                 '✅ Documento recebido e salvo com sucesso!'
        };

        let message = messages[categoria] || messages.outros;

        if (resumo && resumo !== 'Não foi possível analisar automaticamente'
                   && resumo !== 'Texto não extraído — documento salvo para análise manual') {
            message += `\n\n📝 Resumo: ${resumo.substring(0, 200)}`;
        }

        return message;
    }

    /**
     * Salva documento no sistema
     */
    async saveDocument(tempPath, metadata) {
        const { conversationId, clienteId, processoId, tipo, categoria } = metadata;
        
        const filename = path.basename(tempPath);
        const timestamp = Date.now();
        const ext = path.extname(filename);
        
        const destinationFolder = processoId ? 'processos' : 'clientes';

        const destPath = path.join(
            this.documentsPath,
            destinationFolder,
            `${clienteId || conversationId}_${timestamp}${ext}`
        );

        try {
            await fs.rename(tempPath, destPath);

            const result = await db.query(
                `INSERT INTO documentos (
                    conversation_id,
                    cliente_id,
                    processo_id,
                    filename_original,
                    filename_sistema,
                    filepath,
                    tipo_documento,
                    texto_extraido,
                    analise_ia,
                    filesize,
                    created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                RETURNING id`,
                [
                    conversationId,
                    clienteId || null,
                    processoId || null,
                    filename,
                    path.basename(destPath),
                    destPath,
                    categoria || tipo || 'outros',
                    metadata.text?.substring(0, 10000) || '',
                    JSON.stringify(metadata.analysis || {}),
                    metadata.size || 0
                ]
            );

            logger.info('Documento salvo com sucesso', {
                documentoId: result.rows[0].id,
                filepath: destPath,
                categoria: categoria || tipo
            });

            return {
                documentoId: result.rows[0].id,
                filepath: destPath,
                filename: path.basename(destPath)
            };

        } catch (error) {
            logger.error('Erro ao salvar documento', { error: error.message, destPath });
            throw error;
        }
    }

    /**
     * Processa documento recebido via WhatsApp (FUNÇÃO PRINCIPAL)
     */
    async handleWhatsAppDocument(messageData) {
        const { 
            mediaUrl, 
            filename, 
            mimeType, 
            conversationId,
            clienteId,
            processoId,
            caption,
            messageId
        } = messageData;

        logger.info('Processando documento recebido', { filename, conversationId });

        try {
            // 1. Baixar arquivo — usa Evolution base64 endpoint (descriptografa corretamente)
            const tempPath = await this.downloadFromWhatsApp(mediaUrl, filename, messageId || null);

            // 2. Validar
            const stats = await fs.stat(tempPath);
            const validation = this.validateFile(filename, stats.size);

            if (!validation.valid) {
                await fs.unlink(tempPath);
                throw new Error(validation.reason);
            }

            // 3. Extrair texto — para imagens passa o caption para melhorar o contexto do Vision
            const extracted = await this.processDocument(tempPath, caption || '');

            // 4. Categorizar
            const categoria = await this.categorizeDocument(extracted.text, filename);
            logger.info('Documento categorizado', { filename, categoria });

            // 5. Analisar com IA
            const analysis = await this.analyzeDocument(extracted.text, filename);

            // 6. Salvar
            const saved = await this.saveDocument(tempPath, {
                conversationId,
                clienteId,
                processoId,
                text: extracted.text,
                analysis,
                tipo: analysis.tipo,
                categoria,
                size: stats.size
            });

            logger.info('Documento processado com sucesso', { 
                documentoId: saved.documentoId,
                categoria,
                viaVision: extracted.viaVision || false
            });

            return {
                success: true,
                documentoId: saved.documentoId,
                tipo: analysis.tipo,
                categoria,
                resumo: analysis.resumo,
                analysis,
                filepath: saved.filepath,
                // Texto completo para a IA usar ao responder ao cliente
                // Para imagens: descrição Vision ou texto OCR
                // Para documentos: texto extraído
                textoParaIA: extracted.text || '',
                viaVision: extracted.viaVision || false,
                isImage: ['.jpg', '.jpeg', '.png', '.webp'].includes(
                    path.extname(filename).toLowerCase()
                )
            };

        } catch (error) {
            logger.error('Erro ao processar documento do WhatsApp', { 
                error: error.message,
                filename 
            });

            return {
                success: false,
                error: error.message,
                textoParaIA: '',
                isImage: false
            };
        }
    }

    /**
     * Buscar documentos de um cliente
     */
    async getClientDocuments(clienteId) {
        try {
            const result = await db.query(
                `SELECT id, filename_original, tipo_documento, analise_ia, created_at
                FROM documentos
                WHERE cliente_id = $1
                ORDER BY created_at DESC`,
                [clienteId]
            );
            return result.rows;
        } catch (error) {
            logger.error('Erro ao buscar documentos do cliente', { error: error.message, clienteId });
            return [];
        }
    }

    /**
     * Buscar documentos de um processo
     */
    async getProcessDocuments(processoId) {
        try {
            const result = await db.query(
                `SELECT id, filename_original, tipo_documento, analise_ia, created_at
                FROM documentos
                WHERE processo_id = $1
                ORDER BY created_at DESC`,
                [processoId]
            );
            return result.rows;
        } catch (error) {
            logger.error('Erro ao buscar documentos do processo', { error: error.message, processoId });
            return [];
        }
    }

    /**
     * Estatísticas de documentos por categoria
     */
    async getDocumentStats(clienteId = null) {
        try {
            let query = `
                SELECT 
                    tipo_documento as categoria,
                    COUNT(*) as total,
                    SUM(filesize) as tamanho_total
                FROM documentos
            `;
            const params = [];
            if (clienteId) {
                query += ` WHERE cliente_id = $1`;
                params.push(clienteId);
            }
            query += ` GROUP BY tipo_documento ORDER BY total DESC`;

            const result = await db.query(query, params);
            return result.rows;
        } catch (error) {
            logger.error('Erro ao buscar estatísticas', { error: error.message });
            return [];
        }
    }
}

module.exports = new DocumentProcessor();