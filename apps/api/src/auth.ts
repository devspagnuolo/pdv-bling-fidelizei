import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export type AuthPrincipal = {
  operatorId: string;
  operatorName: string;
  role: 'OPERATOR' | 'MANAGER' | 'ADMIN';
  exp: number;
  jti?: string;
};

const secret = () => process.env.PDV_AUTH_SECRET;
// Com PIN individual obrigatório, os PINs compartilhados deixam de ser necessários.
export const individualPinRequired = () => process.env.PDV_REQUIRE_INDIVIDUAL_PIN === '1';
export const authConfigured = () => Boolean(secret() && (individualPinRequired() || (process.env.PDV_OPERATOR_PIN && process.env.PDV_MANAGER_PIN)));
// Em produção a API nunca roda sem login: sem configuração, as rotas protegidas recusam o acesso.
export const authRequired = () => process.env.NODE_ENV === 'production' || process.env.PDV_REQUIRE_AUTH === '1';
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const sign = (payload: string) => createHmac('sha256', secret()!).update(payload).digest('base64url');

export const authenticatePin = (pin: string): AuthPrincipal['role'] | undefined => {
  if (!authConfigured() || !pin) return undefined;
  if (process.env.PDV_ADMIN_PIN && safeEqual(pin, process.env.PDV_ADMIN_PIN)) return 'ADMIN';
  if (individualPinRequired()) return undefined;
  if (process.env.PDV_MANAGER_PIN && safeEqual(pin, process.env.PDV_MANAGER_PIN)) return 'MANAGER';
  if (process.env.PDV_OPERATOR_PIN && safeEqual(pin, process.env.PDV_OPERATOR_PIN)) return 'OPERATOR';
  return undefined;
};

export const validPinFormat = (pin: string) => /^\d{6,12}$/.test(pin);
export const hashPin = (pin: string) => {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
};
export const verifyPinHash = (pin: string, stored: string) => {
  const [scheme, saltText, hashText] = stored.split('$');
  if (scheme !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64');
  const actual = scryptSync(pin, Buffer.from(saltText, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
};

export const issueToken = (principal: Omit<AuthPrincipal, 'exp' | 'jti'>) => {
  if (!authConfigured()) throw new Error('Autenticação do PDV não configurada');
  const payload = Buffer.from(JSON.stringify({
    ...principal,
    jti: randomBytes(16).toString('base64url'),
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
};
export const verifyToken = (token: string | undefined): AuthPrincipal | undefined => {
  if (!authConfigured() || !token) return undefined;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return undefined;
  try {
    const principal = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthPrincipal;
    if (!principal.operatorId || !principal.role || principal.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return principal;
  } catch {
    return undefined;
  }
};
export const bearerToken = (req: FastifyRequest) => {
  const authorization = req.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
};
export const principalFromRequest = (req: FastifyRequest) =>
  (req as FastifyRequest & { auth?: AuthPrincipal }).auth;
