declare module 'pg' {
  const pg: { Pool: new (options: { connectionString: string }) => { query: (text: string, values?: unknown[]) => Promise<unknown> } };
  export default pg;
}
