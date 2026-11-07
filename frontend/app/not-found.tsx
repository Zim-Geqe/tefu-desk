import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { DeskMark } from './desk-mark';

export default function NotFound() {
  return <main className="route-state"><span className="brand-mark"><DeskMark/></span><div className="eyebrow">404 · PAGE NOT FOUND</div><h1>That page isn’t on this desk.</h1><p>The link may have changed, or the page may no longer exist.</p><Link className="button primary" href="/"><ArrowLeft size={15}/> Back to Tefo Desk</Link></main>;
}
