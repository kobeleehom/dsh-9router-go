import { createDecipheriv, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RouterController, resolveOptions } from './src/controller.mjs'
import { deriveCliToken, provisionModelRoute } from './src/provision.mjs'
import { ZcodeController, readZcodeToken, resolveZcodeOptions } from './src/zcode.mjs'
import { registerZcodeProvider } from './src/zcode-provision.mjs'

export const name = 'dsh-9router-go'
export const inject = ['subprocess']

/**
 * Attach one 9router-go sidecar to the active DSH profile and, when configured,
 * publish it as a DSH model provider.
 *
 * When the ZCode block is enabled the plugin also owns a second sidecar: the
 * `zcode2api` proxy that republishes a ZCode Start Plan account as an
 * OpenAI-compatible endpoint. The gateway stays the single DSH-facing route, so
 * the proxy is registered into it as a custom provider rather than published
 * separately; that keeps the gateway's combos and fallbacks able to reference
 * the ZCode models.
 * @param ctx - Cordis context of this profile entry.
 * @param config - sidecar, provider and zcode options declared by `cordis.patch.yml`.
 */
export async function apply(ctx, config = {}) {
  const profileHome = ctx.get('profileContext')?.home
  const options = resolveOptions(config, profileHome)
  const zcode = resolveZcodeOptions(config.zcode ?? {}, profileHome ?? homedir())
  const controller = new RouterController(options, ctx.subprocess, { log: ctx.logger })
  const zcodeController = zcode.enabled
    ? new ZcodeController(zcode, ctx.subprocess, { log: ctx.logger })
    : undefined
  // Whether the optional proxy is actually serving. A proxy failure is logged
  // and survived: the gateway is the DSH-facing service, and a third-party
  // binary that cannot start must not cost the deployment its other providers.
  const zcodeState = { ready: false }
  await ctx.effect(async () => {
    if (zcodeController !== undefined) {
      // Fail soft on a missing account: the proxy is still useful with an
      // empty pool, and a credential problem must not take the gateway down.
      try {
        const seedToken = await resolveZcodeSeedToken({ seedToken: zcode.seedToken, rootDir: zcode.rootDir })
        if (seedToken !== undefined) zcodeController.seedToken = seedToken
        else ctx.logger.warn('zcode: no ZCode account found; sign in through the proxy dashboard to add one')
      } catch (error) {
        ctx.logger.warn(`zcode: could not read the stored ZCode account: ${error.message}`)
      }
      try {
        await zcodeController.initialize()
        zcodeState.ready = true
      } catch (error) {
        ctx.logger.warn(`zcode: proxy unavailable, continuing without it: ${error.message}`)
        await zcodeController.close().catch(() => {})
      }
    }
    try {
      await controller.initialize()
    } catch (error) {
      await zcodeController?.close()
      throw error
    }
    let unprovide
    try {
      unprovide = ctx.provide('nineRouterGo', controller)
      ctx.logger.info(`9router-go ${controller.version} ready at ${controller.endpoint}`)
      if (zcodeState.ready) {
        ctx.provide('zcodeProxy', zcodeController)
        ctx.logger.info(`zcode proxy ready at ${zcodeController.endpoint}`)
      }
    } catch (error) {
      await controller.close()
      await zcodeController?.close()
      throw error
    }
    return async () => {
      unprovide()
      await controller.close()
      if (zcodeState.ready) await zcodeController?.close()
    }
  }, '9router-go: managed sidecar')
  if (options.provider.autoInject) {
    // Registered after readiness: the gateway must be answering before a key can
    // be provisioned, and the injection scope keeps services a composition may
    // lack from gating the sidecar's own activation.
    ctx.inject(['settings', 'credentials', 'llm'], (scope) => {
      void provisionRoutes({
        scope,
        controller,
        zcodeController: zcodeState.ready ? zcodeController : undefined,
        zcode,
        provider: options.provider,
      }).catch((error) => {
        scope.logger.warn(`9router-go: automatic model route injection failed: ${error.message}`)
      })
    })
  }
}

/**
 * Order the two provisioning steps that share one gateway.
 *
 * The ZCode node is registered first and awaited: the gateway derives
 * `?connected=1` from its own connections, so publishing the DSH route before
 * that node is active would advertise a catalog without the ZCode models.
 * @param options - injected services, both controllers, and route settings.
 */
async function provisionRoutes({ scope, controller, zcodeController, zcode, provider }) {
  if (zcodeController !== undefined) {
    await registerZcodeProvider({
      endpoint: controller.endpoint,
      token: await deriveCliToken(controller.dataDir),
      proxyEndpoint: zcodeController.endpoint,
      apiKey: zcode.authToken,
      prefix: zcode.routePrefix,
      models: zcode.models,
      routeName: zcode.routeName,
      log: scope.logger,
    })
  }
  await provisionModelRoute({
    settings: scope.settings,
    credentials: scope.credentials,
    llm: scope.llm,
    endpoint: controller.endpoint,
    dataDir: controller.dataDir,
    provider,
    log: scope.logger,
  })
}

/**
 * Resolve the ZCode account token the proxy should seed its pool with.
 *
 * An explicit `seedToken` always wins so a caller can pin a specific account.
 * Otherwise the token is read from the ZCode desktop app's own credential
 * store, which is what lets the plugin work without the operator pasting a
 * JWT by hand. A store that is absent is not an error: the proxy simply starts
 * with an empty pool and the operator signs in through its dashboard.
 * @param options - configured seed token, proxy root, and credential location.
 * @returns the token, or undefined when the machine holds none.
 */
export async function resolveZcodeSeedToken({ seedToken, rootDir, credentialsPath }) {
  if (typeof seedToken === 'string' && seedToken.trim().length > 0) return seedToken.trim()
  return readZcodeToken({
    credentialsPath: credentialsPath ?? join(homedir(), '.zcode', 'v2', 'credentials.json'),
    home: homedir(),
    username: process.env.USERNAME ?? process.env.USER ?? '',
    createDecipheriv,
    createHash,
  })
}
