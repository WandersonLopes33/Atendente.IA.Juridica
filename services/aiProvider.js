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

// Configuração de provedores
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
    // Disponível apenas se a chave estiver configurada
    available: !!(grokAI?.isAvailable()),
    priority: 2,
    generate: groqAI?.generateResponse, // Para respostas normais usa Groq mesmo
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

// Cache de status de saúde dos provedores
const healthCache = {
  groq:      { healthy: true,  lastCheck: Date.now(), failures: 0 },
  grok:      { healthy: true,  lastCheck: Date.now(), failures: 0 },
  anthropic: { healthy: false, lastCheck: 0, failures: 0 },
  openai:    { healthy: false, lastCheck: 0, failures: 0 },
  ollama:    { healthy: false, lastCheck: 0, failures: 0 }
};

const HEALTH_CHECK_INTERVAL   = 5 * 60 * 1000; // 5 minutos
const MAX_FAILURES_BEFORE_SKIP = 3;

// ─────────────────────────────────────────────────────────────────────────────
// BUSCA JURÍDICA NA WEB (Grok xAI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifica se a mensagem do cliente requer busca jurídica na internet.
 * Se sim, usa o Grok (xAI) com web_search.
 * Caso contrário, retorna null e o fluxo normal (Groq) segue.
 *
 * @param {string} userMessage - Mensagem do cliente
 * @param {string} clienteNome - Nome do cliente
 * @returns {Promise<Object|null>} Resposta ou null se não precisar de busca
 */
async function tryWebSearch(userMessage, clienteNome = 'cliente') {
  // Só tenta se o Grok estiver disponível e a mensagem pedir info atualizada
  if (!grokAI?.isAvailable()) return null;
  if (!grokAI.needsWebSearch(userMessage)) return null;

  logger.info('Roteando para busca jurídica na web (Grok xAI)', {
    cliente: clienteNome,
    preview: userMessage.substring(0, 80)
  });

  const result = await grokAI.buscarInformacaoJuridica(userMessage, clienteNome);

  if (result.success) {
    return {
      success: true,
      content: result.content,
      provider: 'grok',
      providerName: 'Grok xAI',
      usedWebSearch: true,
      wasFallback: false
    };
  }

  // Se o Grok falhou, loga e deixa o fluxo normal assumir
  logger.warn('Grok xAI falhou na busca — seguindo com Groq normal', {
    error: result.error
  });
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getConfiguredProvider() {
  const provider = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
  if (!PROVIDERS[provider] || !PROVIDERS[provider].available) {
    logger.warn(`Provedor ${provider} não disponível, usando Groq como fallback`);
    return 'groq';
  }
  return provider;
}

function getAvailableProviders() {
  return Object.entries(PROVIDERS)
    .filter(([_, config]) => config.available)
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([name]) => name);
}

async function checkProviderHealth(providerName) {
  const provider = PROVIDERS[providerName];
  const cache = healthCache[providerName];
  const now = Date.now();

  if (cache && (now - cache.lastCheck) < HEALTH_CHECK_INTERVAL) {
    return cache.healthy;
  }

  if (!provider || !provider.available || !provider.checkHealth) {
    healthCache[providerName] = { healthy: false, lastCheck: now, failures: cache.failures };
    return false;
  }

  try {
    const isHealthy = await provider.checkHealth();
    healthCache[providerName] = {
      healthy: isHealthy,
      lastCheck: now,
      failures: isHealthy ? 0 : cache.failures + 1
    };
    logger.info(`Provedor ${provider.name}`, { healthy: isHealthy ? 'OK' : 'FALHOU' });
    return isHealthy;
  } catch (error) {
    logger.error(`Erro ao verificar saúde do provedor ${provider.name}`, { error: error.message });
    healthCache[providerName] = { healthy: false, lastCheck: now, failures: cache.failures + 1 };
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GERAÇÃO DE RESPOSTA PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gera resposta usando o provedor configurado.
 * 
 * FLUXO:
 * 1. Se a mensagem pede info jurídica atualizada → tenta Grok (web_search)
 * 2. Caso contrário (ou se Grok falhar) → usa Groq normalmente
 *
 * @param {Array} messages - Mensagens da conversa
 * @param {Object} options - Opções adicionais (clienteNome, etc.)
 * @returns {Promise<Object>} Resposta da IA
 */
async function generateResponse(messages, options = {}) {
  const enableFallback = process.env.FEATURE_AI_FALLBACK_ENABLED !== 'false';
  const primaryProvider = getConfiguredProvider();
  const availableProviders = getAvailableProviders();

  // Extrair última mensagem do usuário para análise
  const lastUserMessage = [...messages]
    .reverse()
    .find(m => m.role === 'user')?.content || '';

  const clienteNome = options.clienteNome || 'cliente';

  // ── Passo 1: tentar busca jurídica na web (Grok) se necessário ──
  const webSearchResult = await tryWebSearch(lastUserMessage, clienteNome);
  if (webSearchResult) {
    return webSearchResult;
  }

  // ── Passo 2: fluxo normal com Groq (e fallback para outros provedores) ──
  const providersToTry = [
    primaryProvider,
    ...availableProviders.filter(p => p !== primaryProvider && p !== 'grok')
  ];

  logger.info('Iniciando geração de resposta (Groq)', {
    primaryProvider,
    fallbackEnabled: enableFallback,
    totalProviders: providersToTry.length
  });

  let lastError = null;

  for (let i = 0; i < providersToTry.length; i++) {
    const providerName = providersToTry[i];
    const provider = PROVIDERS[providerName];
    const cache = healthCache[providerName];

    if (cache.failures >= MAX_FAILURES_BEFORE_SKIP) {
      logger.warn(`Pulando provedor ${provider.name} — muitas falhas consecutivas`, {
        failures: cache.failures
      });
      continue;
    }

    if (i > 0) {
      const isHealthy = await checkProviderHealth(providerName);
      if (!isHealthy) {
        logger.warn(`Provedor ${provider.name} não está saudável, tentando próximo`);
        continue;
      }
    }

    try {
      logger.info(`Tentando provedor ${provider.name}`, {
        attempt: i + 1,
        totalAttempts: providersToTry.length
      });

      const startTime = Date.now();
      const response = await provider.generate(messages, options);
      const duration = Date.now() - startTime;

      if (response && response.success) {
        logger.info('Resposta gerada com sucesso', {
          provider: provider.name,
          duration,
          wasFallback: i > 0
        });

        healthCache[providerName].failures = 0;

        return {
          ...response,
          provider: providerName,
          providerName: provider.name,
          wasFallback: i > 0,
          usedWebSearch: false
        };
      } else {
        lastError = response?.error || 'Resposta vazia';
        logger.warn(`Provedor ${provider.name} retornou erro`, { error: lastError });
        healthCache[providerName].failures++;
      }

    } catch (error) {
      lastError = error;
      logger.error(`Erro ao usar provedor ${provider.name}`, {
        error: error.message,
        stack: error.stack
      });
      healthCache[providerName].failures++;
    }

    if (!enableFallback) break;
  }

  // Todos os provedores falharam
  logger.error('Todos os provedores de IA falharam', {
    providersAttempted: providersToTry.length,
    lastError: lastError?.message || lastError
  });

  return {
    success: false,
    error: 'all_providers_failed',
    message: 'Todos os serviços de IA estão temporariamente indisponíveis. Tente novamente em alguns instantes.',
    details: lastError?.message || lastError
  };
}

/**
 * Gerar resposta simples (uma mensagem, sem histórico)
 */
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
      webSearchEnabled: name === 'grok' && grokAI?.isAvailable()
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
  getConfiguredProvider,
  getAvailableProviders,
  // Exposto para uso direto se necessário
  tryWebSearch
};