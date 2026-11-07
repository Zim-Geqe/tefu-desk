import type { Metadata } from 'next';
import './styles.css';
export const metadata: Metadata = { title: 'Tefo Desk — Business, in good order', description: 'A calm workspace for customer orders and verified payments.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en-ZA"><body>{children}</body></html>; }
