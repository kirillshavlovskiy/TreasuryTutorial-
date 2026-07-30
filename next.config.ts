import path from 'path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Prefer this app’s lockfile over a parent ~/package-lock.json.
  outputFileTracingRoot: path.join(__dirname),
  // Sequelize loads `pg` at runtime — keep it out of the Next server bundle.
  serverExternalPackages: ['pg', 'pg-hstore', 'sequelize'],
};

export default nextConfig;
