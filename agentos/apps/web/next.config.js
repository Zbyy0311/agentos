/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  distDir: process.env.AGENTOS_NEXT_DIST_DIR || '.next',
  typescript: {
    tsconfigPath: process.env.AGENTOS_NEXT_TSCONFIG_PATH || 'tsconfig.json',
  },
};

module.exports = nextConfig;
