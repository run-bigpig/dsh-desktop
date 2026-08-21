# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- Turn the request into 2-5 concrete, verifiable acceptance criteria.
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Preserve Existing Architecture and Framework Boundaries

**Understand the system before extending it. Preserve the guarantees already in place.**

When creating or extending a project:
- If a codebase, scaffold, template, architecture, dependency set, or framework has already been selected, inspect its structure, conventions, dependency graph, existing patterns, and supported extension points before designing or coding.
- Prefer the project's established abstractions and integration paths when they cover the need. Do not introduce a parallel architecture or replace or bypass a dependency or framework without explicit justification.
- Keep feature logic modular, but integrate it through the lifecycle and control boundaries of the adopted architecture and frameworks, such as dependency injection, routing, state management, persistence, middleware, and configuration.
- Do not make a feature work by bypassing those boundaries in a way that disables framework hooks, guarantees, cross-cutting behavior, or existing functionality.
- If the requirement does not fit the current boundaries, explain the mismatch and tradeoffs before changing the architecture or introducing or replacing dependencies.
- Verify the feature through the project's normal entry points and regression tests, confirming that the existing architecture and framework behavior remains effective.

## 4. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Every changed line must directly serve the user's request, fix a bug, add a focused test, or clean up something introduced by your change.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 5. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 6. Observability And Logs

**Make failures diagnosable without creating noise or leaking data.**

- Add logs only on important failure paths or state transitions where they help locate the issue.
- Do not log secrets, tokens, credentials, PII, or full payloads that may contain sensitive data.
- Avoid noisy repeated logs in hot paths, loops, polling, or high-volume request handlers.
- Preserve useful error context instead of swallowing errors behind vague messages.

## 7. Production-Grade Product Work

**Build for real product requirements, not for the appearance of a real product.**

- Treat app, site, and product work as something users may actually rely on.
- Do not settle for "looks like a real product" as the quality bar; meet the standard of a real, formal product.
- Cover the core workflow end to end, including realistic states, validation, empty/error/loading states, accessibility, responsive behavior, and practical maintainability when they are relevant to the request.
- Keep the scope focused on what was asked, but make the requested surface complete and usable rather than decorative or demo-only.

## 8. Third-Party Integrations

**Verify integrations against current primary sources before changing code.**

- Before implementing or modifying a third-party API, SDK, webhook, OAuth flow, payment flow, cloud service, or external platform integration, search for and read the official API documentation, developer guide, OpenAPI spec, SDK docs, or vendor reference.
- Prefer official documentation and source repositories over blog posts, examples, or memory.
- Do not guess endpoint paths, parameters, authentication schemes, rate limits, error formats, SDK method names, or required scopes.
- If official information is unavailable or unclear, state the uncertainty, use the best available source, and keep assumptions explicit in the implementation notes.

## 9. Sub-Agent Restraint

**Keep work in the main agent by default.**

- Unless the user explicitly requests sub-agents, do not spawn them for routine or small tasks.
- Use the minimum number of sub-agents needed. Avoid delegation for simple inspections, single-file changes, or inherently sequential work.
- When a sub-agent is needed, use `5.6 Terra`, `5.6 Luna`, `5.5`, or `5.4`. Do not use `5.6 Sol`.

## 10. DSH-DeskTop Project Identity And Scope

These project-specific rules override generic preferences when they conflict.

- Product name: `DSH-DeskTop`.
- Windows executable name: `dsh-desktop.exe`.
- Default per-user install directory: `%LOCALAPPDATA%\Programs\DSH-DeskTop`.
- Default private data directory: `%APPDATA%\DSH-DeskTop`.
- Inspect the current branch before editing. The active development branch is expected to be `dev-frontend` unless the user changes it; do not switch branches without authorization.
- This repository is an independent Wails 3 desktop shell. Do not fork, copy, patch, or vendor the DeepSeek Harness repository into the project as application source.
- Do not add Git submodules or depend on an adjacent repository to build a release.
- Harness Web remains the primary UI. The desktop loads the official loopback page directly; do not introduce an iframe, RPC proxy, parallel renderer architecture, or Wails bindings into the Harness page.
- The local Wails frontend is limited to startup and desktop-owned transitional UI. Do not restore the removed recovery/update page architecture unless explicitly requested.
- Do not port Electron-only layouts, IPC carriers, desktop plugins, or terminal menus from unrelated reference projects.

## 11. Runtime And Toolchain Boundaries

- The build toolchain may use locked Node, pnpm, and PortableGit.
- PortableGit is build-time only. It may be used to fetch and verify the pinned Harness commit, but it must not be copied into the release stage, installer, install directory, or private runtime toolchain.
- The shipped runtime toolchain contains only:
  - `node.exe` and the Node license;
  - the complete locked pnpm runtime directory, including `pnpm.exe` and its supporting `dist` files.
- Never package `pnpm.exe` by itself. Preserve the locked pnpm archive layout under `resources/toolchain/pnpm`, including at minimum `dist/pnpm.mjs`, `dist/pnpmrc`, `dist/worker.js`, and any runtime `dist/vendor` files supplied by that release. Do not flatten, rename, or selectively prune the pnpm distribution.
- Build scripts may invoke pnpm through locked Node plus `dist/pnpm.mjs`; installer and application paths may invoke `pnpm.exe`. Both entry paths must remain functional from the packaged runtime without system pnpm.
- Runtime and installation must not require system Node, npm, npx, pnpm, or Git.
- Do not add npm or npx merely because a package invokes a package-manager command. Prefer the embedded pnpm path and fix the invocation or packaging boundary.
- Do not package a full Harness `node_modules` tree.
- Package the pinned Harness source/workspace build outputs required for deployment. Install dependencies that are not present in the official Harness repository during installation with embedded pnpm and the official lockfile.
- Preserve and reuse `%APPDATA%\DSH-DeskTop\pnpm-store`. Reinstall, upgrade, plugin install, and plugin uninstall must not delete it.
- The installer may offer only these registries:
  - `https://registry.npmjs.org/` (default);
  - `https://registry.npmmirror.com/`.
- Registry selection applies only to the current install. Never modify global `.npmrc`, pnpm configuration, or the user's normal shell environment.
- Child Node, pnpm, PowerShell, Git, and helper processes must not show visible console windows.

## 12. Harness Version And Seed Rules

- Harness is always pinned to a full commit SHA. Never resolve the latest `master` dynamically during packaging or application startup.
- The authoritative repository remains `https://github.com/deepseek-ai/deepseek-harness.git`.
- Keep `release/seed.lock.json` and `internal/seed/seed.lock.json` synchronized when changing the Harness commit or tool versions.
- Validate Harness `packageManager`, Node requirements, lockfile, CLI entry, and build outputs before publishing a seed.
- When Harness changes, rebuild the built-in desktop plugins against that exact Harness checkout before validating or packaging.
- Harness source/runtime updates are delivered as part of a new desktop release. Do not reintroduce the old in-application Harness source fetch/build/update workflow.
- Old `repository.git/` data may exist from previous versions. Do not depend on it, and do not delete user data opportunistically unless the user explicitly requests cleanup.

### Harness Update Build Procedure And Known Failure Signatures

- Before changing the pinned commit, read the official Harness documentation and the exact commit's root `package.json`. Verify `packageManager`, `engines.node`, CLI entry, and available build scripts from that checkout instead of relying on memory.
- Build Harness from the repository root with the locked Node and the locked pnpm archive's `dist/pnpm.mjs`. The release-equivalent sequence is:

```text
pnpm install --frozen-lockfile
pnpm run build:official
```

- `build:official` is the desktop seed release gate because it builds the official Host, Client, and Web frontend. Do not replace it with partial tsdown commands or hand-built output selection.
- Never patch Harness source, add placeholder output files, or introduce tsdown workarounds merely to make a cached checkout compile. First prove the exact official commit in a completely fresh checkout and dependency tree.
- A Harness commit change invalidates the entire pnpm workspace dependency layout. Deleting only the root `node_modules` is insufficient because package-level workspace links remain. On commit change:
  - directly remove the root `node_modules` directory;
  - clean all remaining untracked workspace dependency links and build output, such as with `git clean -fdx` on the build checkout;
  - preserve only `dist/windows/seed-build/pnpm-store` for reuse.
- When the locked commit is unchanged, retaining the verified `node_modules` layout is allowed. Do not delete and reinstall the full dependency tree on every build.
- Treat these errors as likely stale dependency-layout evidence before diagnosing Harness source:
  - `pnpm.exe` or another executable is treated as JavaScript by a build script;
  - tsdown reports `Cannot find entry: ["lib/types/{index,invariant,startup}.js"]` after switching commits;
  - pnpm reports `Already up to date` immediately after only the root dependency directory was removed.
- An empty initialized Git repository has no `HEAD`. `git rev-parse --verify HEAD` failing with `fatal: Needed a single revision` is a normal empty-checkout state, not a fetch failure. Handle its exit code without allowing Windows PowerShell 5 native stderr handling to terminate the script.
- After a clean official Harness build succeeds, treat later seed failures as desktop integration failures. Do not return to modifying Harness internals unless a fresh official-only build also fails.
- Harness may remove React components from public package exports while retaining them internally. When built-in plugin compilation reports missing exports such as `ImageGallery`, `ImageLoader`, `MessageImageLabels`, or `DropOverlay`:
  - inspect the new official public contract and extension points;
  - use the provided slot owner APIs, such as `renderMessageImages`, instead of importing Harness internal `src` paths;
  - keep desktop-owned presentation, such as the document drop mask, inside the desktop plugin.
- A plugin test run from the Harness checkout uses the copied `packages/desktop` overlay. Rebuild or resync the overlay before testing current repository plugin source; otherwise tests may execute stale code and stale assertions.
- `workspace:` dependencies are expected in the staged installable Harness source because it remains a complete pnpm workspace and is materialized during installation. They are forbidden only in the generated standalone built-in plugin package manifests.
- Linux-only package platform warnings, pre-build missing-bin warnings, and Vite chunk-size warnings are not release failures by themselves. Judge success by command exit status and the required artifacts/smoke checks.
- A Harness commit update is complete only after all of the following pass:
  - a fresh official-only `pnpm install --frozen-lockfile` and `pnpm run build:official`;
  - the complete `scripts/prepare-windows-seed.ps1` flow, including install-state Harness startup/shutdown smoke;
  - built-in plugin Host, Client, and Bundle compilation against the exact checkout;
  - relevant plugin tests and Windows PowerShell Go tests;
  - production Windows GUI EXE generation and stage inspection for the exact commit, no full `node_modules`, and no shipped Git/npm/npx.
- Do not generate NSIS as part of a Harness update verification unless the user explicitly requests packaging.

## 13. Built-In Plugin Architecture

- Built-in plugin source lives in this repository under:
  - `plugin/packages/plugin-host`;
  - `plugin/packages/plugin-client`;
  - `plugin/packages/plugin-bundle`.
- Store the original unpacked plugin source in the repository. Do not make checked-in or adjacent `.tgz` files the source of truth.
- The build may generate package directories for the release stage; it should not require prebuilt `.tgz` artifacts.
- `plugin-host` owns the trusted local desktop gateway.
- `plugin-client` owns Harness settings-page injection and desktop UI integration.
- `plugin-bundle` composes the host/client packages and Harness patch.
- When changing a built-in plugin, keep all three package versions synchronized with `desktopPluginVersion` in Go. Increment the version when the installed profile must refresh; do not rely on same-version pnpm replacement.
- Build plugins against the pinned Harness using the existing Typert/TypeScript extension points. Do not bypass Harness plugin lifecycle or introduce a second plugin system.
- Generated plugin packages must contain no unresolved `workspace:` dependency specifiers.

## 14. Plugin Hub And Trust Model

- The GitHub plugin hub is the application marketplace source. Production catalog URLs and signing configuration must not be silently redirected.
- A custom remote/ref is allowed only through an explicitly enabled developer mode with a persistent warning.
- Keep Ed25519 catalog signature verification. It protects catalog integrity and is not a plugin review badge.
- Keep immutable GitHub Release `.tgz` download requirements and per-artifact SHA-256 verification.
- Do not install from mutable branch archives or arbitrary unverified URLs in production mode.
- Do not enforce or display Harness commit compatibility for marketplace plugins.
- Do not return or display per-plugin `compatible`, `verified`, “reviewed”, or “unreviewed” status.
- Do not display or reserve layout space for the removed warning: “Harness plugins run with your user permissions. Install only from publishers you trust.”
- Do not disable plugin install/update based on legacy compatibility metadata still present in a signed catalog. Legacy fields may remain in remote JSON but the application ignores them.
- Catalog signature status may remain visible because it describes source integrity, not plugin review.
- Do not edit a signed `catalog.json` without producing a matching `catalog.sig`. If the signing key is unavailable, keep the last verified catalog and report the limitation.
- Third-party plugin lifecycle scripts remain disabled during marketplace installation unless the user explicitly changes this security model.

## 15. Plugin Profile Transaction Rules

- Plugin mutations must run against an isolated profile and activate only after the mutation and configuration validation succeed.
- The live profile must remain unchanged until activation.
- Plugin install/uninstall failures must not leave the active Harness profile partially modified.
- Stop Harness before swapping profiles. If the new profile fails to start, restore the previous profile and restart it.
- pnpm lockfiles containing local `file:` dependencies are position-dependent. Never copy such a lockfile into a transaction at a different directory depth.
- Drop a staged profile lockfile before running pnpm and drop the regenerated lockfile before moving the profile into its live location.
- Built-in plugin upgrades must also discard the live position-dependent profile lockfile before and after pnpm execution.
- A built-in plugin upgrade must detach the old `node_modules` directory by rename before reinstalling. This keeps removal off the startup critical path.
- If dependency installation fails, remove the partial dependency directory and restore the detached one.
- After success, clean the detached dependency directory asynchronously.
- Never recursively copy `node_modules` into a plugin transaction.
- Preserve the shared pnpm content-addressed store across all transactions.
- Plugin uninstall must remain available for installed plugins regardless of any legacy catalog compatibility metadata.

## 16. Desktop Lifecycle And UX Constraints

- Launch Harness with the embedded Node runtime and the official CLI entry through `child-control.mjs`.
- Bind only to `127.0.0.1` and use an ephemeral port.
- Accept only a strict loopback ready line and verify the homepage contains `window.__DSH_BOOT__` before navigation.
- After Harness becomes ready, keep the splash visible for the configured final hold before completing the transition.
- The splash is borderless. The normal framed window must not appear until the Harness page transition is complete.
- Restart transitions must reset all splash animation/progress state and must not reuse stale progress.
- Avoid white/black intermediary windows, frame flashes, size jumps, and progress rollback.
- Closing the normal window hides to tray by default. Explicit Exit must terminate the Harness process tree.
- Windows process trees use Job Objects; POSIX uses process groups. Graceful stdin shutdown is attempted before forced tree termination.
- The tray remains the owner of open, restart Harness, manual desktop update check, log access, dsh terminal, and exit actions.
- Automatic desktop update checks remain disabled. Only user-initiated checks are allowed.

## 17. Development Workflow

Use this one-way flow:

```text
repository source
  -> Windows build cache
  -> dist/windows/stage
  -> direct installed-state smoke test
  -> NSIS package
  -> clean-machine validation
  -> release
```

- Repository source is authoritative.
- `dist/windows/seed-build` and downloaded archives are build caches, not release inputs by convention unless a script explicitly verifies them.
- `dist/windows/stage` is generated release material, not a source directory. Never copy edits from an installed app or old stage back into source.
- A direct replacement of the installed EXE/plugin resources is acceptable for local development verification only.
- Direct installed-state testing does not replace NSIS testing.
- When replacing an installed resource for a smoke test, stop the running application, keep a precise rollback copy until readiness succeeds, then remove only that rollback copy.
- Preserve unrelated worktree changes. This project frequently has intentional uncommitted work; inspect `git status` and focused diffs before editing.
- Do not commit, push, tag, publish a release, or change a remote unless explicitly requested.

## 18. Verification Gates

For source changes, run the smallest relevant checks first, then the release-appropriate gates.

### Static checks

- Run `gofmt` on changed Go files.
- Build/type-check changed TypeScript plugin packages through the existing Harness plugin build.
- Run `git diff --check`.
- Search generated plugin output for removed strings/fields when changing UI contracts.
- Check built-in plugin package versions and the Go version constant match.

### Windows tests

- Release-relevant Go tests must run through Windows PowerShell, not only under WSL.
- At minimum, changes in this area should cover:
  - `./internal/plugin`;
  - `./internal/desktop`;
  - `./internal/selfupdate`;
  - `./internal/update`.
- WSL failures caused by missing WebKitGTK or Windows-only self-update behavior are not release evidence. Run the Windows equivalents.

### Plugin integration checks

- Build host, client, and bundle against the pinned Harness checkout.
- Verify all generated package versions.
- Verify no generated manifest contains `workspace:`.
- Verify the generated client no longer contains removed compatibility/review/risk strings.
- Verify Harness loads the host/client/bundle and the settings tab opens.
- Verify plugin install, update, uninstall, Harness restart, and rollback behavior when those paths change.

### Runtime smoke checks

- Confirm both `dsh-desktop.exe` and the embedded Node Harness process are running.
- Confirm the desktop log records strict readiness, the one-second hold, navigation, and completed window swap.
- Confirm the installed built-in plugin version matches the source version.
- Confirm the live profile has no position-dependent `pnpm-lock.yaml` after plugin management.
- Inspect failure logs for transaction-local `plugin/bundle` ENOENT, `0xfffff026`, visible-console regressions, and failed process cleanup.

## 19. Windows And WSL Execution Rules

- The repository is edited from WSL, but Windows release tests/builds must execute in Windows.
- Invoke Windows PowerShell through `/init` using the full executable path when required, for example `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`.
- Do not assume bare `powershell.exe` interop works from the current environment.
- Use Windows paths inside PowerShell and WSL paths inside Bash; do not mix them implicitly.
- Escape PowerShell `$env:` expressions so Bash does not expand them.
- Avoid commands that open visible consoles. Use non-interactive, hidden-window process configuration for product paths.
- Resolve exact install/data targets before cleanup. Prefer rename/detach followed by background deletion for large dependency trees.
- Never recursively delete the workspace root, a user profile root, `%APPDATA%`, `%LOCALAPPDATA%`, or the shared pnpm store.

## 20. Packaging Rules

- Do not build or rebuild NSIS unless the user explicitly asks for packaging.
- Before packaging, regenerate/verify the complete stage from current source. Never assume an existing installer or stage is current.
- `scripts/prepare-windows-seed.ps1` is responsible for:
  - verifying locked downloads;
  - fetching/checking out the pinned Harness commit with build-time Git;
  - frozen dependency install and complete Harness build;
  - staging source without `node_modules`;
  - building the built-in plugins;
  - Harness smoke testing;
  - publishing only Node and pnpm into the runtime toolchain stage.
- Build the production Windows EXE with the existing production tag, Windows GUI subsystem, version metadata, and release API metadata.
- Before NSIS compilation, verify that stage contains no:
  - PortableGit;
  - npm or npx;
  - full Harness `node_modules`;
  - adjacent-repository references;
  - stale plugin versions;
  - stale Harness commits.
- Before NSIS compilation, also verify the staged pnpm runtime contains `pnpm.exe`, `dist/pnpm.mjs`, `dist/pnpmrc`, `dist/worker.js`, and the other support files from the locked pnpm archive. Do not reduce the runtime to a standalone `pnpm.exe`.
- NSIS upgrades must close the running desktop app after user confirmation (silent mode may close automatically), preserve private data and pnpm store, and restore the previous resources/EXE if dependency deployment fails.
- Installer dependency deployment uses embedded pnpm and the selected allowed registry.
- Large old resources or dependency directories should be detached by rename and cleaned outside the critical install path.
- After generating `dist/windows/DSH-DeskTop-Setup-x64.exe`, calculate a new SHA-256 and update the sidecar. Never reuse a previous checksum.
- Treat any existing NSIS file as stale until its contents, timestamp, version, seed commit, plugin version, and checksum are verified against current source.

## 21. Release And Update Model

- Desktop self-update is a normal full-application update:
  - user manually checks GitHub Release;
  - app downloads the complete NSIS installer;
  - app verifies SHA-256;
  - app closes;
  - the hidden update helper performs silent install;
  - the new app restarts.
- Do not mix desktop self-update with Harness source updates or plugin catalog updates.
- A Harness commit update requires a new desktop seed, rebuilt built-in plugins, full verification, and a new desktop release.
- A marketplace plugin update requires an immutable GitHub Release asset, SHA-256 update, catalog update, and new catalog signature.
- Release gates include:
  - Windows Go tests;
  - plugin build/type generation;
  - local installed-state smoke;
  - first install and overwrite install;
  - official registry and npmmirror paths;
  - no-system-Node/npm/pnpm/Git machine;
  - plugin install/uninstall;
  - single instance, tray, dsh terminal, restart, and process-tree cleanup;
  - absence of visible Node/CMD windows;
  - correct installer checksum.
- Windows x64 is the production support gate. Do not claim macOS or Linux production support until their native packaging, signing/dependency, and clean-machine tests pass.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
