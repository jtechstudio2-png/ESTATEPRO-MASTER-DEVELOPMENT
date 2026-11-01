import { redirect } from 'next/navigation';

/** The start page is the property dashboard; the app layout handles sign-in and company choice. */
export default function Home() {
  redirect('/dashboard');
}
