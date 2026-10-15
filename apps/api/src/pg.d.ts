declare module 'pg' {
  type PoolOptions = {
    connectionString: string;
    max?: number;
    statement_timeout?: number;
    query_timeout?: number;
  };
  type PoolInstance = {
    query: (text: string, values?: unknown[]) => Promise<unknown>;
    connect: () => Promise<ClientInstance>;
    end: () => Promise<void>;
  };
  type ClientInstance = {
    query: (text: string, values?: unknown[]) => Promise<unknown>;
    release: () => void;
  };
  const pg: { Pool: new (options: PoolOptions) => PoolInstance };
  export default pg;
}
