import { useQueryClient } from '@tanstack/vue-query';

export interface User {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
}

/**
 * Authentication composable for PKG Dashboard
 *
 * Architecture:
 * - Tokens stored in httpOnly cookies (server-side)
 * - User data cached in useState (SSR-safe)
 * - All auth operations go through Nuxt server routes
 */

// Singleton promise to prevent race conditions during initialization
let initPromise: Promise<void> | null = null;

export const useAuth = () => {
  // State persisted across navigation (SSR-safe)
  const user = useState<User | null>('auth:user', () => null);
  const isLoading = useState<boolean>('auth:loading', () => false);
  const isInitialized = useState<boolean>('auth:initialized', () => false);
  const error = useState<string | null>('auth:error', () => null);

  const isAuthenticated = computed(() => !!user.value);

  const queryClient = useQueryClient();

  /**
   * Login with username and password
   */
  async function login(credentials: LoginCredentials): Promise<void> {
    error.value = null;
    isLoading.value = true;

    try {
      await $fetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: credentials,
      });

      // Fetch user info after successful login
      await fetchUser();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Login failed';
      error.value = message;
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Logout current user
   */
  async function logout(): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore errors - logout should always succeed locally
    } finally {
      user.value = null;
      error.value = null;
      queryClient.clear(); // Clear all cached data
      await navigateTo('/login');
    }
  }

  /**
   * Fetch current user info
   */
  async function fetchUser(): Promise<void> {
    try {
      const userData = await $fetch<User>('/api/auth/me');
      user.value = userData;
      error.value = null;
    } catch {
      user.value = null;
    }
  }

  /**
   * Initialize auth state (call in plugin or layout)
   * Uses singleton promise to prevent race conditions
   */
  async function init(): Promise<void> {
    // Skip if already initialized
    if (isInitialized.value) {
      return;
    }

    // If initialization is in progress, wait for it
    if (initPromise) {
      return initPromise;
    }

    // Start initialization
    isLoading.value = true;
    initPromise = (async () => {
      try {
        await fetchUser();
      } finally {
        isLoading.value = false;
        isInitialized.value = true;
        initPromise = null;
      }
    })();

    return initPromise;
  }

  /**
   * Check if user has specific role
   */
  function hasRole(role: string): boolean {
    return user.value?.role === role;
  }

  /**
   * Check if user is admin
   */
  const isAdmin = computed(() => user.value?.role === 'admin');

  return {
    // State (readonly)
    user: readonly(user),
    isAuthenticated,
    isLoading: readonly(isLoading),
    isInitialized: readonly(isInitialized),
    error: readonly(error),
    isAdmin,

    // Actions
    login,
    logout,
    fetchUser,
    init,
    hasRole,
  };
};
