import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NETSLEUTH",
  description: "Social deduction on a live packet feed. Find the hacker.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
