import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '「이미 있어」 운영 브리핑',
  description: '시스템·사용자·개발활동·트렌드 네 축을 읽어 주간 운영 브리핑 카드뉴스를 만든다',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        {/*
          터미널 글꼴과 한글 산문 글꼴. 둘 다 못 불러와도 읽히도록
          globals.css 의 --mono / --sans 끝에 시스템 대체를 남겨 두었다.
        */}
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
