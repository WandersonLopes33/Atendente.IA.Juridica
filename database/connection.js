/**
 * Database Connection Pool - PostgreSQL
 * Gerencia conexões com o banco de dados
 */

const { Pool } = require('pg');
const logger = require('../utils/logger');

class Database {
  constructor() {
    this.pool = null;
    this.isConnected = false;
  }

  /**
   * Inicializar pool de conexões
   */
  async initialize() {
    try {
      // Configuração do pool
      const config = {
        connectionString: process.env.DATABASE_URL,
        max: parseInt(process.env.DB_POOL_MAX || '20'),
        min: parseInt(process.env.DB_POOL_MIN || '2'),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      };

      // SSL em produção
      if (process.env.NODE_ENV === 'production') {
        config.ssl = {
          rejectUnauthorized: false
        };
      }

      this.pool = new Pool(config);

      // Event handlers
      this.pool.on('error', (err) => {
        logger.error('Unexpected database error:', err);
        this.isConnected = false;
      });

      this.pool.on('connect', () => {
        logger.info('New database client connected');
        this.isConnected = true;
      });

      this.pool.on('remove', () => {
        logger.debug('Database client removed from pool');
      });

      // Testar conexão
      await this.testConnection();
      
      logger.info('PostgreSQL connection pool initialized successfully');
      return this.pool;

    } catch (error) {
      logger.error('Failed to initialize database pool:', error);
      throw error;
    }
  }

  /**
   * Testar conexão
   */
  async testConnection() {
    try {
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW() as now, version() as version');
      client.release();
      
      logger.info('Database connection test successful');
      logger.debug('PostgreSQL version:', result.rows[0].version);
      
      this.isConnected = true;
      return true;
    } catch (error) {
      logger.error('Database connection test failed:', error);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Executar query
   */
  async query(text, params) {
    const start = Date.now();
    
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      
      logger.debug('Query executed', {
        query: text.substring(0, 100),
        duration: `${duration}ms`,
        rows: result.rowCount
      });
      
      return result;
    } catch (error) {
      logger.error('Query error:', {
        query: text.substring(0, 100),
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Executar transação
   */
  async transaction(callback) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obter cliente do pool
   */
  async getClient() {
    return await this.pool.connect();
  }

  /**
   * Obter estatísticas do pool
   */
  getPoolStats() {
    if (!this.pool) return null;
    
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      isConnected: this.isConnected
    };
  }

  /**
   * Fechar pool
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      logger.info('Database pool closed');
    }
  }
}

// Singleton instance
let dbInstance = null;

const getDatabase = () => {
  if (!dbInstance) {
    dbInstance = new Database();
  }
  return dbInstance;
};

// Inicializar automaticamente
const initDatabase = async () => {
  const db = getDatabase();
  await db.initialize();
  return db;
};

module.exports = {
  Database,
  getDatabase,
  initDatabase
};
