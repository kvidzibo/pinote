type Guardian = { node: string; script: string; env: NodeJS.ProcessEnv };

// Set only in Electron's dedicated field-runtime bundle. Standalone callers
// retain the direct launcher, and the HTTP observer never launches handlers.
export let fieldHandlerGuardian: Guardian | undefined;
export function configureFieldHandlerGuardian(guardian: Guardian): void {
  fieldHandlerGuardian = guardian;
}
