## Project Context
- This project is an interface between an Envisalink security card/panel and MQTT plus REST endpoints.
- The repository is a few years old. Treat the README and older code paths as helpful context, but verify behavior in the current source before relying on them.
- Security-system reference documents are stored in `docs` as PDF files.
- Keep application code under `src`. Prefer leaving the repository root for Docker, Compose, package manifests, README files, and other project-level assets.

## Logging And Errors
- Read `logger.md` before changing or adding application logging/error handling.
- Use the structured logger/error flow from `src/logging.js` and `src/logger.js` for new code: `generateLog(...)` for normal events, `generateError(...)` for raised errors, and `wrapError(...)` when rethrowing/bubbling errors.
- Keep error keys in `src/errors.json` and generate new ones with `err_gen.js` instead of inventing error codes by hand.
- Do not add new `console.log`, `console.error`, `console.warn`, or `throw new Error(JSON.stringify(...))` patterns in application code unless there is a clear reason the shared logger cannot be used.
- When adding a new error-producing block, create a distinct `errorKey` for that block rather than reusing a generic key.

## WSL2 Command Environment
- This repository is run in WSL2.
- Non-interactive shells may not load `~/.bashrc` (and therefore may not load `nvm`).
- Before `node`/`npm` commands, initialize `nvm` explicitly:
  `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"`
