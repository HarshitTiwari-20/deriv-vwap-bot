import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Avoid monorepo lockfile root inference warnings on Vercel
  outputFileTracingRoot: path.join(__dirname, '../..'),
  eslint: {
    // Lint locally; don't fail production image builds on plugin noise
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
