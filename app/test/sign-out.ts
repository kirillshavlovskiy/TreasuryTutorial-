'use server';

import { redirect } from 'next/navigation';

export async function signOutToHome() {
  redirect('/api/auth/logout');
}
