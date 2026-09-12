import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signal · Conversation intelligence",
  description: "Surface the conversations that need human judgment.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
