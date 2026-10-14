// Minimal Worker: reports its own version so each redeploy is visible from both Cloudflare and DuploCloud.
export default {
  async fetch(request, env) {
    return Response.json({
      worker: "duplo-watch-demo",
      version: env.APP_VERSION,
      servedAt: new Date().toISOString(),
    });
  },
};
