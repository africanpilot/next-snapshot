import Link from "next/link";

import Where from "./Where";

export const metadata = { title: "next-snapshot fixture" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link> <Link href="/about">About</Link>
        </nav>
        {children}
        <p>
          pathname: <Where />
        </p>
      </body>
    </html>
  );
}
