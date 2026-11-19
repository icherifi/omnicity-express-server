declare global {
  namespace NodeJS {
    interface ProcessEnv {
      SUPABASE_URL: string;
      SUPABASE_ANON_KEY: string;
      SUPABASE_SERVICE_ROLE_KEY?: string;
      CORS_ORIGINS?: string;
      IZI_AUTH_TOKEN?: string;
      ADEME_CLIENT_ID?: string;
      ADEME_CLIENT_SECRET?: string;
    }
  }
}

export {};
