/**
 * Force in-tree `.next` for production builds on OneDrive.
 * Off-tree AppData distDir breaks ESM resolution for sequelize/pg.
 */
process.env.NEXT_FORCE_LOCAL_DIST = '1';
require('./register-node-path.cjs');
require('../node_modules/next/dist/bin/next');
