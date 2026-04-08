import mysql, { Pool, PoolConnection, ResultSetHeader } from "mysql2/promise";

const pool: Pool = mysql.createPool({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? "root",
  password: process.env.DB_PASSWORD ?? "",
  database: process.env.DB_NAME ?? "jobizy",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 10),
  namedPlaceholders: false,
});


const columnPresenceCache = new Map<string, boolean>();

export async function query<T = any>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function queryOne<T = any>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await pool.execute(sql, params as any[]);
  return result as ResultSetHeader;
}

export async function withTransaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function pingDatabase() {
  await query("SELECT 1 AS ok");
}

export async function hasTable(table: string) {
  const [rows] = await pool.query<any[]>(
    `SELECT 1
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1`,
    [table],
  );
  return Array.isArray(rows) && rows.length > 0;
}

export async function hasColumn(table: string, column: string) {
  const cacheKey = `${table}.${column}`;
  if (columnPresenceCache.has(cacheKey)) {
    return columnPresenceCache.get(cacheKey)!;
  }

  const [rows] = await pool.query<any[]>(
    `SELECT 1
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column],
  );

  const exists = Array.isArray(rows) && rows.length > 0;
  columnPresenceCache.set(cacheKey, exists);
  return exists;
}

export { pool };
