/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  distDir: process.env.AGENTOS_NEXT_DIST_DIR || '.next',
};

module.exports = nextConfig;
