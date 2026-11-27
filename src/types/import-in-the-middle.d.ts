// import-in-the-middle ships `register-hooks.d.ts` next to `register-hooks.mjs`; TypeScript
// looks for `register-hooks.d.mts`, so the subpath has no types. Mirrors the shipped
// declaration (import-in-the-middle 3.5.x) for the part src/instrumentation.ts uses.
declare module "import-in-the-middle/register-hooks.mjs" {
  export interface RegisterHooksOptions {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
    disableCjsSourceStripping?: boolean;
  }
  /** Registers the loader as synchronous, in-thread hooks via `module.registerHooks()`. */
  export function register(options?: RegisterHooksOptions): void;
  /** Whether the running Node.js can run the synchronous loader. */
  export function supportsSyncHooks(): boolean;
}
