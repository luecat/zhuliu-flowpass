import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  async headers() {
    return [{
      source: '/app/:path*',
      headers: [
        { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
        { key: 'Pragma', value: 'no-cache' },
        { key: 'Expires', value: '0' },
      ],
    }];
  },
  env: {
    NEXT_PUBLIC_FLOWPASS_LIFF_ID: process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID ?? '2011336492-ay7OJ4mO',
  },
};

export default nextConfig;
