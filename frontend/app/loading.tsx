import { LoaderCircle } from 'lucide-react';
import { DeskMark } from './desk-mark';

export default function Loading() {
  return <main className="loading-screen"><div className="brand-mark"><DeskMark/></div><LoaderCircle className="spin" size={20}/><span>Opening your Tefo Desk workspace</span></main>;
}
