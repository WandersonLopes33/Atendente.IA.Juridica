/**
 * Cache Helper - Redis Integration
 * Gerencia cache de respostas da IA e sessões de conversa
 */

const redis = require('redis');
const logger = require('./logger');

class CacheManager {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.enabled = process.env.REDIS_ENABLED === 'true';

    if (this.enabled) {
      this.initialize();
    }
  }

  async initialize() {
    try {
      this.client = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        password: process.env.REDIS_PASSWORD || undefined,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logger.error('Redis: Max retries reached');
              return new Error('Max retries reached');
            }
            return Math.min(retries * 100, 3000);
          }
        }
      });

      this.client.on('error', (err) => {
        logger.error('Redis Client Error:', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis connected successfully');
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        logger.info('Redis client ready');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        logger.warn('Redis reconnecting...');
      });

      await this.client.connect();
    } catch (error) {
      logger.error('Failed to initialize Redis:', error.message);
      this.enabled = false;
      this.isConnected = false;
    }
  }

  /**
   * Cachear resposta de IA
   */
  async setCachedResponse(key, value, ttl = 300) {
    if (!this.enabled || !this.isConnected) return null;

    try {
      const data = JSON.stringify(value);
      await this.client.setEx(key, ttl, data);
      logger.debug(`Cached AI response: ${key}`);
      return true;
    } catch (error) {
      logger.error('Error caching response:', error.message);
      return null;
    }
  }

  /**
   * Obter resposta cacheada
   */
  async getCachedResponse(key) {
    if (!this.enabled || !this.isConnected) return null;

    try {
      const cached = await this.client.get(key);
      if (cached) {
        logger.debug(`Cache hit: ${key}`);
        return JSON.parse(cached);
      }
      return null;
    } catch (error) {
      logger.error('Error getting cached response:', error.message);
      return null;
    }
  }

  /**
   * Salvar sessão de conversa
   */
  async setSession(telefone, sessionData, ttl = 1800) {
    if (!this.enabled || !this.isConnected) return null;

    try {
      const key = `session:${telefone}`;
      const data = JSON.stringify({
        ...sessionData,
        lastActivity: Date.now()
      });
      await this.client.setEx(key, ttl, data);
      return true;
    } catch (error) {
      logger.error('Error setting session:', error.message);
      return null;
    }
  }

  /**
   * Obter sessão de conversa
   */
  async getSession(telefone) {
    if (!this.enabled || !this.isConnected) return null;

    try {
      const key = `session:${telefone}`;
      const session = await this.client.get(key);
      if (session) {
        return JSON.parse(session);
      }
      return null;
    } catch (error) {
      logger.error('Error getting session:', error.message);
      return null;
    }
  }

  /**
   * Deletar sessão
   */
  async deleteSession(telefone) {
    if (!this.enabled || !this.isConnected) return null;

    try {
      const key = `session:${telefone}`;
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error('Error deleting session:', error.message);
      return null;
    }
  }

  /**
   * Rate limiting por telefone
   */
  async checkRateLimit(telefone, maxRequests = 10, windowSeconds = 60) {
    if (!this.enabled || !this.isConnected) return true; // Permitir se Redis offline

    try {
      const key = `ratelimit:${telefone}`;
      const current = await this.client.incr(key);

      if (current === 1) {
        await this.client.expire(key, windowSeconds);
      }

      return current <= maxRequests;
    } catch (error) {
      logger.error('Error checking rate limit:', error.message);
      return true; // Permitir em caso de erro
    }
  }

  /**
   * Cachear disponibilidade de viagem
   */
  async cacheViagemDisponibilidade(viagemId, assentosDisponiveis, ttl = 300) {
    if (!this.enabled || !this.isConnected) return null;

    try {
      const key = `viagem:${viagemId}:assentos`;
      await this.client.setEx(key, ttl, assentosDisponiveis.toString());
      return true;
    } catch (error) {
      logger.error('Error caching viagem:', error.message);
      return null;
    }
  }

  /**
   * Obter disponibilidade de viagem do cache
   */
  async getViagemDisponibilidade(viagemId) {
    if (!this.enabled || !this.isConnected) return null;

    try {
      const key = `viagem:${viagemId}:assentos`;
      const assentos = await this.client.get(key);
      return assentos ? parseInt(assentos, 10) : null;
    } catch (error) {
      logger.error('Error getting viagem from cache:', error.message);
      return null;
    }
  }

  /**
   * Invalidar cache de viagem
   */
  async invalidateViagemCache(viagemId) {
    if (!this.enabled || !this.isConnected) return null;

    try {
      const key = `viagem:${viagemId}:assentos`;
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error('Error invalidating cache:', error.message);
      return null;
    }
  }

  /**
   * Limpar todo o cache
   */
  async flushAll() {
    if (!this.enabled || !this.isConnected) return null;

    try {
      await this.client.flushAll();
      logger.info('Redis cache flushed');
      return true;
    } catch (error) {
      logger.error('Error flushing cache:', error.message);
      return null;
    }
  }

  /**
   * Obter estatísticas do Redis
   */
  async getStats() {
    if (!this.enabled || !this.isConnected) {
      return { enabled: false, connected: false };
    }

    try {
      const info = await this.client.info('stats');
      const dbSize = await this.client.dbSize();
      
      return {
        enabled: true,
        connected: this.isConnected,
        dbSize,
        stats: info
      };
    } catch (error) {
      logger.error('Error getting Redis stats:', error.message);
      return { enabled: true, connected: false, error: error.message };
    }
  }

  /**
   * Fechar conexão
   */
  async close() {
    if (this.client && this.isConnected) {
      await this.client.quit();
      logger.info('Redis connection closed');
    }
  }
}

// Singleton instance
let cacheInstance = null;

const getCacheManager = () => {
  if (!cacheInstance) {
    cacheInstance = new CacheManager();
  }
  return cacheInstance;
};

// Exports específicos para compatibilidade
const setCachedResponse = async (key, value, ttl) => {
  const cache = getCacheManager();
  return await cache.setCachedResponse(key, value, ttl);
};

const getCachedResponse = async (key) => {
  const cache = getCacheManager();
  return await cache.getCachedResponse(key);
};

module.exports = {
  CacheManager,
  getCacheManager,
  setCachedResponse,
  getCachedResponse
};
