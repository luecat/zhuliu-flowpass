import type { Metadata } from 'next';
import './globals.css';

const title = '竹流 FlowPass｜AI 使用流向護照 JSON 生成器';
const description =
  '分開填寫資料、AI 用途、可能個資與分享去向，一鍵產生符合 FlowPass 黑客松架構的英文 JSON 提示詞。';

export const metadata: Metadata = {
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
