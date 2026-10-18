import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export type AuthPrincipal = {
  operatorId: string;
  operatorName: string;
  role: 'OPERATOR' | 'MANAGER' | 'ADMIN';
  exp: number;
};

const secret = () => process.env.PDV_AUTH_SECRET;
export const authConfigured = () => Boolean(secret() && process.env.PDV_OPERATOR_PIN && process.env.PDV_MANAGER_PIN);
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const sign = (payload: string) => createHmac('sha256', secret()!).update(payload).digest('base64url');

export const authenticatePin = (pin: string): AuthPrincipal['role'] | undefined => {
  if (!authConfigured()) return undefined;
  if (process.env.PDV_ADMIN_PIN && safeEqual(pin, process.env.PDV_ADMIN_PIN)) return 'ADMIN';
  if (safeEqual(pin, process.env.PDV_MANAGER_PIN!)) return 'MANAGER';
  if (safeEqual(pin, process.env.PDV_OPERATOR_PIN!)) return 'OPERATOR';
  return undefined;
};
export const issueToken = (principal: Omit<AuthPrincipal, 'exp'>) => {
  if (!authConfigured()) throw new Error('Autenticação do PDV não configurada');
  const payload = Buffer.from(JSON.stringify({
    ...principal,
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
export const principalFromRequest = (req: FastifyRequest) =>
  (req as FastifyRequest & { auth?: AuthPrincipal }).auth;

