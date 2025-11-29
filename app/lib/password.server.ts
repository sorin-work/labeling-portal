import bcrypt from 'bcryptjs';

const ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 10;

export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
