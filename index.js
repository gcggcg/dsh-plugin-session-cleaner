/**
 * Host half of the session-cleaner bundle.
 *
 * The host module owns the only stateful capability the client cannot provide:
 * permanently removing a stored Session (log directory plus workspace/global
 * bookkeeping) on behalf of the sidebar. It is exposed to the browser half over
 * one authenticated route, `/api/session-cleaner/*`, registered on the Web
 * server. See `src/host/plugin.js` for the implementation.
 *
 * @module dsh-plugin-session-cleaner
 */
export { name, inject, apply } from './src/host/plugin.js';
