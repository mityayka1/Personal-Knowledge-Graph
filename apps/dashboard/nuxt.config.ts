// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true },

  modules: ['@nuxtjs/tailwindcss'],

  css: ['~/assets/css/main.css'],

  // Configure component auto-imports
  components: {
    dirs: [
      {
        path: '~/components/ui',
        pathPrefix: false,
        extensions: ['vue'],
      },
      {
        path: '~/components',
        pathPrefix: false,
        extensions: ['vue'],
      },
    ],
  },

  runtimeConfig: {
    // Server-side only (not exposed to client)
    apiKey: process.env.API_KEY || '',
    pkgCoreUrl: process.env.PKG_CORE_URL || 'http://localhost:3000/api/v1',
    // Note: TELEGRAM_ADAPTER_URL removed - Dashboard routes through PKG Core proxy

    // Public (exposed to client)
    public: {
      appName: 'PKG Dashboard',
    },
  },

  typescript: {
    strict: true,
    typeCheck: true,
  },

  app: {
    head: {
      title: 'PKG Dashboard',
      meta: [
        { name: 'description', content: 'Personal Knowledge Graph Dashboard' },
      ],
    },
  },

  compatibilityDate: '2024-12-01',
});
