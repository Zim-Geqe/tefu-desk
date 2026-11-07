'use client';

import { RefreshCw } from 'lucide-react';
import { DeskMark } from './desk-mark';

export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <main className="route-state"><span className="brand-mark"><DeskMark/></span><div className="eyebrow">TEFO DESK · WORKSPACE</div><h1>This workspace could not load.</h1><p>Your account data is safe. Check your connection and try again.</p><button className="button primary" onClick={retry}><RefreshCw size={15}/> Try again</button></main>;
}
