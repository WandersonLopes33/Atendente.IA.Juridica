const logger = require('../utils/logger');

// Importar provedores disponíveis
let groqAI, grokAI;

try {
  groqAI = require('./groqAI');
} catch (err) {
  logger.warn('Groq AI não disponível', { error: err.message });
}

try {
  grokAI = require('./grokAI');
} catch (err) {
  logger.warn('Grok AI (xAI) não disponível', { error: err.message });
}

// ─── NOVA LÓGICA: INTEGRAÇÃO TAVILY E DECISÃO DE PESQUISA ─────────────────────

/**
 * Consulta o Tavily para obter dados atualizados da web
 */
async function consultarTavily(query) {
  if (process.env.WEB_SEARCH_ENABLED !== 'true') return null;
  
  try {
    logger.info('IA solicitou busca técnica para confirmação', { query });
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: query,
        search_depth: "advanced",
        include_answer: true,
        max_results: 3
      })
    });

    const data = await response.json();
    return data.answer || (data.results && data.results.length > 0 ? JSON.stringify(data.results) : null);
  } catch (error) {
    logger.error("❌ Erro ao consultar Tavily", { error: error.message });
    return null;
  }
}

/**
 * Analisa se a mensagem do usuário exige uma pesquisa externa
 */
async function decidirNecessidadeDePesquisa(userMessage) {
  try {
    const promptDecisao = [
      {
        role: 'system',
        content: `Aja como um triador jurídico. Responda apenas "PESQUISAR" se a pergunta envolver:
        1. Leis, decretos, jurisprudência ou prazos processuais.
        2. Fatos recentes ou notícias que podem ter mudado.
        3. Qualquer tema onde a precisão técnica seja vital.
        Caso contrário, responda "INTERNO".`
      },
      { role: 'user', content: userMessage }
    ];

    // Tenta usar o provedor configurado para decidir
    const providerKey = getConfiguredProvider();
    const provider = PROVIDERS[providerKey];
    
    if (provider && provider.generate) {
      const result = await provider.generate(promptDecisao, { max_tokens: 10 });
      // Se for um objeto de fallback do aiProvider, extraímos o conteúdo
      const textResult = typeof result === 'string' ? result : (result.content || "");
      return textResult.includes("PESQUISAR");
    }
    return false;
  } catch {
    return false;
  }
}

// ─── CONFIGURAÇÃO DE PROVEDORES (ORIGINAL MANTIDA) ──────────────────────────

const PROVIDERS = {
  groq: {
    name: 'Groq (Llama)',
    available: !!groqAI,
    priority: 1,
    generate: groqAI?.generateResponse,
    checkHealth: groqAI?.checkHealth
  },
  grok: {
    name: 'Grok xAI',
    available: !!(grokAI?.isAvailable()),
    priority: 2,
    generate: groqAI?.generateResponse, // Mantido conforme seu original
    checkHealth: grokAI?.checkHealth
  },
  anthropic: {
    name: 'Anthropic Claude',
    available: false,
    priority: 3,
    generate: null,
    checkHealth: null
  },
  openai: {
    name: 'OpenAI',
    available: false,
    priority: 4,
    generate: null,
    checkHealth: null
  },
  ollama: {
    name: 'Ollama (Local)',
    available: false,
    priority: 5,
    generate: null,
    checkHealth: null
  }
};

const healthCache = {
  groq: { healthy: true, lastCheck: 0, failures: 0 },
  grok: { healthy: true, lastCheck: 0, failures: 0 }
};

// ─── GERAÇÃO DE RESPOSTA (LÓGICA ORIGINAL + INJEÇÃO DE BUSCA) ───────────────

async function generateResponse(messages, options = {}) {
  const enableFallback = process.env.FEATURE_AI_FALLBACK_ENABLED !== 'false';
  const primaryProvider = getConfiguredProvider();
  
  // Captura a última mensagem para decidir sobre a pesquisa
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';

  // INJEÇÃO DA LÓGICA DE BUSCA
  if (process.env.WEB_SEARCH_ENABLED === 'true') {
    const precisaPesquisar = await decidirNecessidadeDePesquisa(lastUserMessage);
    if (precisaPesquisar) {
      const contextoWeb = await consultarTavily(lastUserMessage);
      if (contextoWeb && messages[0] && messages[0].role === 'system') {
        messages[0].content += `\n\n[CONFIRMAÇÃO TÉCNICA DA WEB]: ${contextoWeb}\nUse estes dados para garantir precisão jurídica.`;
      }
    }
  }

  // Lista de provedores para tentar (Lógica original de fallback)
  const availableProviders = getAvailableProviders();
  const providersToTry = [primaryProvider, ...availableProviders.filter(p => p !== primaryProvider)];

  for (const providerName of providersToTry) {
    const provider = PROVIDERS[providerName];
    
    if (!provider || !provider.available) continue;

    // Verificar saúde se fallback habilitado
    if (enableFallback && !await checkProviderHealth(providerName)) {
      logger.warn(`Pulando provedor ${providerName} por estar instável`);
      continue;
    }

    try {
      const content = await provider.generate(messages, options);
      
      if (content) {
        // Resetar falhas em caso de sucesso
        if (healthCache[providerName].failures > 0) {
          healthCache[providerName].failures = 0;
          healthCache[providerName].healthy = true;
        }
        
        return {
          success: true,
          content,
          provider: providerName,
          timestamp: new Date()
        };
      }
    } catch (err) {
      logger.error(`Erro no provedor ${providerName}:`, { error: err.message });
      
      healthCache[providerName].failures++;
      if (healthCache[providerName].failures >= 3) {
        healthCache[providerName].healthy = false;
      }
    }
  }

  return {
    success: false,
    message: 'Nenhum provedor de IA disponível ou saudável no momento.',
    tried: providersToTry
  };
}

// ─── FUNÇÕES AUXILIARES (ORIGINAIS INTEGRAS) ────────────────────────────────

function getConfiguredProvider() {
  return process.env.AI_PROVIDER || 'groq';
}

function getAvailableProviders() {
  return Object.keys(PROVIDERS).filter(p => PROVIDERS[p].available);
}

async function checkProviderHealth(providerName) {
  const cache = healthCache[providerName];
  const config = PROVIDERS[providerName];

  if (!config || !config.available) return false;

  // Se estiver saudável e checado nos últimos 5 min, confia no cache
  if (cache.healthy && (Date.now() - cache.lastCheck < 5 * 60 * 1000)) {
    return true;
  }

  // Se tem muitas falhas e checado recentemente, mantém instável
  if (!cache.healthy && (Date.now() - cache.lastCheck < 2 * 60 * 1000)) {
    return false;
  }

  try {
    const isHealthy = config.checkHealth ? await config.checkHealth() : true;
    cache.healthy = isHealthy;
    cache.lastCheck = Date.now();
    if (isHealthy) cache.failures = 0;
    return isHealthy;
  } catch (err) {
    cache.healthy = false;
    cache.lastCheck = Date.now();
    return false;
  }
}

async function generateSimpleResponse(userMessage, options = {}) {
  const messages = [{ role: 'user', content: userMessage }];
  const result = await generateResponse(messages, options);

  if (result.success) {
    return result.content;
  } else {
    throw new Error(result.message || 'Erro ao gerar resposta');
  }
}

/**
 * Status de todos os provedores
 */
async function getProvidersStatus() {
  const status = {};

  for (const [name, config] of Object.entries(PROVIDERS)) {
    const cache = healthCache[name];
    status[name] = {
      name: config.name,
      available: config.available,
      healthy: cache.healthy,
      failures: cache.failures,
      lastCheck: cache.lastCheck ? new Date(cache.lastCheck).toISOString() : null,
      isPrimary: name === getConfiguredProvider(),
      webSearchEnabled: process.env.WEB_SEARCH_ENABLED === 'true'
    };
  }

  return status;
}

function resetFailureCounters() {
  for (const provider in healthCache) {
    healthCache[provider].failures = 0;
  }
  logger.info('Contadores de falha resetados para todos os provedores');
}

async function checkAllProvidersHealth() {
  const results = {};
  for (const [name, config] of Object.entries(PROVIDERS)) {
    results[name] = config.available ? await checkProviderHealth(name) : false;
  }
  return results;
}

module.exports = {
  generateResponse,
  generateSimpleResponse,
  getProvidersStatus,
  checkProviderHealth,
  checkAllProvidersHealth,
  resetFailureCounters,
  consultarTavily,
  decidirNecessidadeDePesquisa
};