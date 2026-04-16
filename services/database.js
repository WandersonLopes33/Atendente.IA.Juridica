const { Pool } = require('pg');
const logger = require('../utils/logger');

// Configuração do pool de conexões PostgreSQL
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME     || 'railway',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD,
        ssl:      false
      }
);

// Event listeners para monitoramento
pool.on('connect', () => {
    logger.info('✅ Conexão estabelecida com PostgreSQL');
});

pool.on('error', (err) => {
    logger.error('❌ Erro inesperado no pool PostgreSQL', { error: err.message });
});

// Testar conexão inicial
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        logger.error('❌ Falha ao conectar com PostgreSQL', { error: err.message });
    } else {
        logger.info('🗄️  PostgreSQL conectado com sucesso', { timestamp: res.rows[0].now });
    }
});

// Helper para executar queries
const query = async (text, params) => {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        
        logger.debug('Query executada', {
            text: text.substring(0, 100) + '...',
            duration: `${duration}ms`,
            rows: res.rowCount
        });
        
        return res;
    } catch (error) {
        logger.error('Erro na query', {
            error: error.message,
            query: text.substring(0, 100)
        });
        throw error;
    }
};

// Helper para transações
const transaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Transação falhou, ROLLBACK executado', { error: error.message });
        throw error;
    } finally {
        client.release();
    }
};

module.exports = {
    pool,
    query,
    transaction
};
