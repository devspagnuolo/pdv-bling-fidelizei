import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';

const BLING_TOKEN_URL = 'https://api.bling.com.br/Api/v3/oauth/token';
const FETCH_TIMEOUT_MS = 15_000;
let refreshInFlight: Promise<string | undefined> | undefined;
type BlingTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

const encryptionKey = () => {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('CREDENTIALS_ENCRYPTION_KEY deve possuir 32 bytes em base64');
    return key;
  }
  const fallback = process.env.BLING_CLIENT_SECRET;
  if (!fallback) throw new Error('Chave de criptografia ou segredo Bling não configurado');
  return createHash('sha256').update(fallback).digest();
};
const encrypt = (value: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
};
const decrypt = (value: string) => {
  const payload = Buffer.from(value, 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};
const clientCredentials = () => {
  const id = process.env.BLING_CLIENT_ID;
  const secret = process.env.BLING_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Credenciais do aplicativo Bling não configuradas');
  return { id, secret };
};
const requestTokens = async (body: URLSearchParams): Promise<BlingTokenResponse> => {
  const { id, secret } = clientCredentials();
  const response = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'enable-jwt': '1'
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  const payload = await response.json() as BlingTokenResponse & {
    error?: { message?: string; description?: string } | string;
  };
  if (!response.ok || !payload.access_token) {
    const detail = typeof payload.error === 'string'
      ? payload.error
      : payload.error?.description ?? payload.error?.message;
    throw new Error(detail ?? `Falha na autenticação do Bling (HTTP ${response.status})`);
  }
  return payload;
};
const saveBlingTokens = async (tokens: BlingTokenResponse) => {
  if (!pool) throw new Error('Banco de dados necessário para armazenar a conexão Bling');
  const expiresAt = new Date(Date.now() + Math.max(60, tokens.expires_in ?? 21_600) * 1000);
  await pool.query(
    `insert into integration_credentials
      (provider, access_token, refresh_token, expires_at, metadata)
     values ('BLING', $1, $2, $3, $4::jsonb)
     on conflict (provider) do update set
       access_token = excluded.access_token,
       refresh_token = coalesce(excluded.refresh_token, integration_credentials.refresh_token),
       expires_at = excluded.expires_at,
       metadata = excluded.metadata,
       updated_at = now()`,
    [
      encrypt(tokens.access_token),
      tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      expiresAt,
      JSON.stringify({ tokenType: tokens.token_type, scope: tokens.scope, jwt: true })
    ]
  );
  return expiresAt;
};

export const exchangeBlingAuthorizationCode = async (code: string) => {
  const redirectUri = process.env.BLING_REDIRECT_URI;
  if (!redirectUri) throw new Error('URL de retorno do aplicativo Bling não configurada');
  const tokens = await requestTokens(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }));
  const expiresAt = await saveBlingTokens(tokens);
  return { expiresAt };
};
export const getBlingAccessToken = async (): Promise<string | undefined> => {
  if (pool) {
    const result = await pool.query(
      `select access_token, refresh_token, expires_at
       from integration_credentials where provider = 'BLING'`
    ) as {
      rows: Array<{ access_token: string; refresh_token: string | null; expires_at: Date | null }>;
    };
    const credential = result.rows[0];
    if (credential) {
      try {
        const expiresAt = credential.expires_at?.getTime() ?? 0;
        if (expiresAt > Date.now() + 2 * 60_000) return decrypt(credential.access_token);
        if (!credential.refresh_token) throw new Error('Conexão Bling expirada e sem refresh token');
        if (!refreshInFlight) {
          refreshInFlight = (async () => {
            const tokens = await requestTokens(new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: decrypt(credential.refresh_token!)
            }));
            await saveBlingTokens(tokens);
            return tokens.access_token;
          })().finally(() => { refreshInFlight = undefined; });
        }
        return await refreshInFlight;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/authenticate data|bad decrypt|invalid|expired|revoked/i.test(message)) {
          await pool.query(
            `update integration_credentials
             set metadata = metadata || $1::jsonb, updated_at = now()
             where provider = 'BLING'`,
            [JSON.stringify({ needsReauth: true, lastError: message.slice(0, 500) })]
          );
          return process.env.BLING_ACCESS_TOKEN;
        }
        throw error;
      }
    }
  }
  return process.env.BLING_ACCESS_TOKEN;
};
export const createBlingOAuthState = async () => {
  if (!pool) throw new Error('Banco de dados necessário para iniciar a conexão Bling');
  const state = randomBytes(32).toString('hex');
  await pool.query(
    `insert into oauth_states (state, provider, expires_at)
     values ($1, 'BLING', now() + interval '10 minutes')`,
    [state]
  );
  return state;
};
export const consumeBlingOAuthState = async (state: string) => {
  if (!pool) return false;
  const result = await pool.query(
    `delete from oauth_states
     where state = $1 and provider = 'BLING' and expires_at > now()
     returning state`,
    [state]
  ) as { rowCount: number | null };
  return Boolean(result.rowCount);
};
export const getBlingConnectionStatus = async () => {
  const oauthConfigured = Boolean(process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET && process.env.BLING_REDIRECT_URI);
  try {
    const token = await getBlingAccessToken();
    if (token) return { configured: oauthConfigured, connected: true, mode: pool ? 'oauth' as const : 'manual-token' as const };
  } catch {
    // A interface deve apresentar a reconexão, sem afirmar que um token inválido está ativo.
  }
  return { configured: oauthConfigured, connected: false, mode: 'disconnected' as const };
};
