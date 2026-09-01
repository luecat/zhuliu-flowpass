import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  env: {
    NEXT_PUBLIC_FLOWPASS_LIFF_ID: process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID ?? '2011336492-ay7OJ4mO',
  },
};

export default nextConfig;
