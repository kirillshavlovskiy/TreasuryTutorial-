import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

// Corporate proxy / SSL inspection can break the Google OIDC discovery fetch in
// local dev. Allow relaxed TLS verification only when explicitly opted in and
// never in production.
if (
  process.env.NODE_ENV !== 'production' &&
  process.env.AUTH_ALLOW_INSECURE_TLS === 'true'
) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const googleClientId =
  process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID;
const googleClientSecret =
  process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    }),
  ],
  pages: {
    signIn: '/',
  },
});
