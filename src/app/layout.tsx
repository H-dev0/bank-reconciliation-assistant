import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Bank Reconciliation Assistant", description: "Private, local-first bank and ledger CSV reconciliation with transparent matching and manual review." };
export default function RootLayout({ children }: LayoutProps<"/">) { return <html lang="en"><body>{children}</body></html>; }
