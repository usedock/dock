import { redirect } from 'next/navigation';

// Post-login landing. The dashboard layout already gates the session;
// signed-in operators land on the Docks table.
export default function Home() {
  redirect('/docks');
}
