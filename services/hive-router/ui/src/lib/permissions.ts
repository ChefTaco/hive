import type { AdminUser } from './types';

export function can(user: AdminUser | null, permission: string): boolean {
  const granted = user?.permissions ?? [];
  if (granted.includes('*') || granted.includes(permission)) return true;
  const [domain] = permission.split(':');
  return granted.includes(`${domain}:*`) || granted.some((entry) => entry.endsWith(':*') && permission.startsWith(entry.slice(0, -1)));
}

export function canAny(user: AdminUser | null, permissions: string[]): boolean {
  return permissions.some((permission) => can(user, permission));
}
