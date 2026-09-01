import type { Metadata } from 'next';
import './globals.css';

const title = '竹流 FlowPass';
const description =
  '從 LINE 填寫申請、確認 AI 使用流向護照並追蹤申請進度。';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.FLOWPASS_PUBLIC_ORIGIN ?? 'http://127.0.0.1:38100'),
  title,
  description,
  applicationName: title,
  openGraph: {
    type: 'website',
    locale: 'zh_TW',
    title,
    description,
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: '竹流 FlowPass AI 使用流向護照',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
