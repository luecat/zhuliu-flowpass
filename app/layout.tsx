import type { Metadata } from 'next';
import './globals.css';

const title = '竹流 FlowPass｜JSON 提示詞與護照解析器';
const description =
  '產生 FlowPass 英文 JSON 提示詞，並在同一頁解析 AI 回傳的資料流、待確認問題與安全措施。';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.FLOWPASS_PUBLIC_ORIGIN ?? 'http://127.0.0.1:38100'),
  title,
  description,
  applicationName: '竹流 FlowPass',
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
