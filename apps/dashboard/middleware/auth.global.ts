/**
 * Global auth middleware
 *
 * Protects all routes except /login
 * Redirects unauthenticated users to login page
 */
export default defineNuxtRouteMiddleware(async (to) => {
  // Skip for login page
  if (to.path === '/login') {
    return;
  }

  const { isAuthenticated, isInitialized, init } = useAuth();

  // Initialize auth if not done yet
  if (!isInitialized.value) {
    await init();
  }

  // Redirect to login if not authenticated
  if (!isAuthenticated.value) {
    const redirectUrl = encodeURIComponent(to.fullPath);
    return navigateTo(`/login?redirect=${redirectUrl}`);
  }
});
