import { handleRequest } from './app'
import { runCron } from './cron'
import { handleEmail } from './email/cloudflare'

export { WorkspaceHub } from './hub/hub'

export default {
  fetch: (req, env, ctx) => handleRequest(req, env, ctx),
  scheduled: (_controller, env, ctx) => ctx.waitUntil(runCron(env)),
  email: (message, env, ctx) => handleEmail(message, env, ctx),
} satisfies ExportedHandler<Env>
