import module from 'module';
import path from 'path';
import type { NextConfig } from 'next';

// Always use in-tree `.next`. Off-tree AppData distDir breaks ESM resolution
// for sequelize/pg (`Cannot find package 'sequelize' imported from AppData/...`).
const distDir = '.next';

const nodePath = path.join(__dirname, 'node_modules');
process.env.NODE_PATH = [nodePath, process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
// `_initPaths()` is a real Node internal — it re-reads NODE_PATH, which is the
// whole point of setting it two lines up — but it is deliberately absent from
// @types/node's public surface, so it needs a cast rather than a type fix.
(module.Module as unknown as { _initPaths(): void })._initPaths();

const nextConfig: NextConfig = {
  distDir,
  // Lint debt is warnings + the occasional prefer-const error. Keep `next lint`
  // / CI as the place that reports it; do not fail `next build` / Vercel.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // The live spot poll runs ~2x/second per open ticket and Next logs every
  // request in dev, which buried the [fx-exec] / [tape-load] / [strip-open]
  // lines this app is actually diagnosed from. Matched against path AND
  // query, so /api/fx-spot/candles — one request per From-window click, and
  // the line that settles "which window did the chart ask for" — stays.
  logging: {
    incomingRequests: {
      ignore: [/^\/api\/fx-spot\?/],
    },
  },
  // OneDrive path quirks can break generated route types under nested dirs.
  typescript: {
    ignoreBuildErrors: __dirname.includes('OneDrive'),
  },
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: [
    'pg',
    'pg-native',
    'pg-connection-string',
    'pg-hstore',
    'sequelize',
    '@neondatabase/serverless',
    'ws',
    'bufferutil',
    'utf-8-validate',
    'undici',
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      const extra = [
        'pg',
        'pg-native',
        'pg-connection-string',
        'pg-hstore',
        'sequelize',
      ];
      const externals = config.externals;
      const mark = ({ request }: { request?: string }, next: (err?: null, result?: string) => void) => {
        if (request && extra.includes(request)) {
          next(null, `commonjs ${request}`);
          return;
        }
        next();
      };
      if (Array.isArray(externals)) externals.push(mark);
      else if (externals) config.externals = [externals, mark];
      else config.externals = [mark];
    }
    return config;
  },
};

export default nextConfig;
