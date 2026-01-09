export default defineEventHandler(() => {
  return {
    status: 'ok',
    service: 'pkg-dashboard',
    timestamp: new Date().toISOString(),
  };
});
