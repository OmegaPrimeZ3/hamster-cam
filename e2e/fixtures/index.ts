// e2e/fixtures/index.ts
//
// Re-exports + convenience aliases. The specs import a single namespace:
//
//   import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

export { startStack } from './stack.js';
export type { StackHandle, StackOptions } from './stack.js';
export type { TestDbHandle, SeededUser, SeededCamera, SeededRecipient } from './db-factory.js';
export type { ZyphrMock, ZyphrUserSeed } from './msw-zyphr.js';

/** Common admin credentials used across most specs. */
export const defaultAdmin = {
  email: 'admin@example.com',
  display_name: 'Admin Adams',
  role: 'admin' as const,
  password: 'test-password-123',
  zyphr_user_id: 'zyphr_admin@example.com',
};

/** Common child credentials. */
export const defaultChild = {
  email: 'kiddo@example.com',
  display_name: 'Kiddo',
  role: 'child' as const,
  password: 'kiddo-password-123',
  zyphr_user_id: 'zyphr_kiddo@example.com',
};
