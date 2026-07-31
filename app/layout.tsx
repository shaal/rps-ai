import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import Script from "next/script";

import "./globals.css";

/** Microsoft Clarity project id for rps.shaal.dev. Not a secret — it ships in
 *  the page either way — but it is the one value here worth being able to find. */
const CLARITY_PROJECT_ID = "xv65n0fk5s";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Adaptive RPS — vector-memory opponent",
  description:
    "Rock paper scissors against an opponent that stores every round as a vector memory and learns to read you.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${archivo.variable} ${jetbrains.variable} h-full`}>
      <body className="min-h-full">
        {children}
        {/*
         * Microsoft Clarity: third-party session analytics — heatmaps and
         * session replay, so it is possible to see where players actually get
         * stuck rather than guessing.
         *
         * `afterInteractive` is the load-bearing part. The tag is fetched from a
         * domain this project does not control, and it has nothing to do with
         * rendering the game, so it is held until after hydration and can never
         * sit in front of first paint. An inline body on `next/script` requires
         * both an `id` and `dangerouslySetInnerHTML` — that is the documented
         * shape, not a way around one.
         */}
        <Script
          id="microsoft-clarity"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function(c,l,a,r,i,t,y){
                  c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
                  t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
                  y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
              })(window, document, "clarity", "script", "${CLARITY_PROJECT_ID}");
            `,
          }}
        />
      </body>
    </html>
  );
}
