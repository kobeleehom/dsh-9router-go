import { RouterController, resolveOptions } from './src/controller.mjs'
import { provisionModelRoute } from './src/provision.mjs'

export const name = 'dsh-9router-go'
export const inject = ['subprocess']

/**
 * Attach one 9router-go sidecar to the active DSH profile and, when configured,
 * publish it as a DSH model provider.
 * @param ctx - Cordis context of this profile entry.
 * @param config - sidecar and provider options declared by `cordis.patch.yml`.
 */
export async function apply(ctx, config = {}) {
  const options = resolveOptions(config, ctx.get('profileContext')?.home)
  const controller = new RouterController(options, ctx.subprocess, { log: ctx.logger })
  await ctx.effect(async () => {
    await controller.initialize()
    let unprovide
    try {
      unprovide = ctx.provide('nineRouterGo', controller)
      ctx.logger.info(`9router-go ${controller.version} ready at ${controller.endpoint}`)
    } catch (error) {
      await controller.close()
      throw error
    }
    return async () => {
      unprovide()
      await controller.close()
    }
  }, '9router-go: managed sidecar')
  if (options.provider.autoInject) {
    // Registered after readiness: the gateway must be answering before a key can
    // be provisioned, and the injection scope keeps services a composition may
    // lack from gating the sidecar's own activation.
    ctx.inject(['settings', 'credentials', 'llm'], (scope) => {
      void provisionModelRoute({
        settings: scope.settings,
        credentials: scope.credentials,
        llm: scope.llm,
        endpoint: controller.endpoint,
        dataDir: controller.dataDir,
        provider: options.provider,
        log: scope.logger,
      }).catch((error) => {
        scope.logger.warn(`9router-go: automatic model route injection failed: ${error.message}`)
      })
    })
  }
}
