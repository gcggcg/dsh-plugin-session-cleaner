/**
 * Host plugin entry: registers the authenticated `/api/session-cleaner` route
 * on `ctx.webServer` and serves permanent Session deletion. See DESIGN.md
 * § Feature 1.
 *
 * The route exists only while this fiber is alive: the registration's disposer
 * is owned by `ctx.effect`, so unloading the plugin removes the route instead
 * of leaving a dangling handler.
 *
 * @module dsh-plugin-session-cleaner/host
 */

import { createSessionCleanerHandler, ROUTE_PREFIX } from './http.js';

/** Stable Cordis plugin name. */
export const name = 'session-cleaner';

/**
 * The route needs the Web server to exist. Every other service
 * (`connection`, `sessionPersistence`, `sessions`, `agents`,
 * `workspaceRegistry`) is read lazily at request time, so the plugin still
 * loads when an optional service is absent from the profile.
 */
export const inject = ['webServer'];

/**
 * Install the host half.
 * @param {object} ctx - host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: createSessionCleanerHandler(webCtx),
        }),
      'session-cleaner: /api/session-cleaner route',
    );
  });
}
