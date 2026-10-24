export type Skill = {
  slug: string;
  name: string;
  description: string;
  homepage: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Release = {
  skillSlug: string;
  version: string;
  sha256: string;
  archivePath: string;
  notes: string | null;
  minHermesVersion?: string | null;
  maxHermesVersion?: string | null;
  createdAt: string;
};

export type Session = { id: string; username: string; expiresAt: string };
export type DeploymentTarget = { name: string; host: string; username: string; enabled: boolean };
export type AuthContext = { username: string; isAdmin: boolean };
