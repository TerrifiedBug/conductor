/**
 * The single seam between omp-conductor and the omp harness.
 *
 * The harness is a `peerDependency`, not a `devDependency`: this package has to
 * type-check and publish without it on disk. So every untyped access lives in
 * this file, behind one cast at the dynamic-import boundary, and the rest of the
 * package only ever sees {@link AgentSessionLike}. If the harness renames
 * `createAgentSession`, `subscribe` or `abort`, exactly one file breaks.
 */

/**
 * Harness package name. Held in a variable and cast to `string` at the call
 * site on purpose: a non-literal specifier stops `tsc` from trying to resolve
 * the module, which is the whole reason this shim exists.
 */
const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";

/**
 * The only session surface the dispatcher is allowed to know about: send one
 * prompt, watch the event stream, and kill it. Caps are enforced by the caller
 * against this interface, never by the model inside the session.
 */
export interface AgentSessionLike {
  prompt(text: string, opts?: Record<string, unknown>): Promise<unknown>;
  /**
   * Subscribe to one harness event type (`"message_end"`, `"agent_end"`, …), or
   * `"*"` for every event. The payload is the harness's own event union, which
   * this package cannot name without the peer dependency, so it arrives as
   * `unknown` and each caller narrows the two or three fields it reads.
   */
  on(event: string, cb: (e: unknown) => void): void;
  abort(): void;
  /**
   * Absolute transcript path the harness opened, so a human — and the
   * arm/monitor tooling — can read what the worker actually did. `undefined`
   * when the session has no file backing; never a path we merely asked for.
   */
  sessionFile?: string;
  /**
   * Set when the harness could not honour the requested model and quietly used
   * another one. Carried out through this seam so the daemon can log the
   * downgrade, instead of it vanishing and a run just reading dumber.
   */
  modelFallbackMessage?: string;
}

/**
 * Module members this shim calls. Checked at the import boundary so a harness
 * bump that drops one fails by name, instead of as `undefined is not a
 * constructor` in the middle of session setup.
 */
const REQUIRED_EXPORTS = ["createAgentSession", "SessionManager", "AgentRegistry"] as const;

/** The three module members this shim calls, all verified before the cast. */
interface OmpModule {
  createAgentSession(opts: unknown): Promise<unknown>;
  /** Only the file-backed factories: `inMemory()` would defeat the transcript. */
  SessionManager: {
    create(cwd: string, sessionDir?: string): unknown;
    /**
     * Resume path. Continues the newest transcript for `cwd`, and the harness
     * itself starts a fresh one when there is nothing to continue. Declared
     * optional — and absent from {@link REQUIRED_EXPORTS} — so a harness build
     * without it degrades to a fresh session instead of failing to start.
     */
    continueRecent?(cwd: string, sessionDir?: string): Promise<unknown>;
  };
  /** Constructed once per session — see the note at the call site. */
  AgentRegistry: new () => unknown;
}

/**
 * The members of the harness `AgentSession` this package touches. The real
 * class has hundreds; declaring four keeps the blast radius of an SDK bump
 * proportional to what we actually depend on.
 */
interface RawSession {
  prompt(text: string, opts?: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): unknown;
  abort(opts?: unknown): void;
  dispose?(opts?: unknown): Promise<unknown>;
  readonly sessionFile?: string;
}

/**
 * Teardown handles, keyed by the adapter we handed out. Kept off
 * {@link AgentSessionLike} so the interface stays exactly the shared contract
 * every other slice codes against, while callers still have a way to release
 * the harness's background work (MCP clients, watchers) instead of leaking it
 * for the lifetime of the daemon.
 */
const disposers = new WeakMap<AgentSessionLike, () => Promise<void>>();

/**
 * Start one omp coding session rooted at `cwd`, with a private agent registry
 * and a file-backed transcript of its own.
 *
 * `sessionDir` chooses the directory the harness writes that transcript into;
 * omitted, the harness picks its default location for `cwd`. Either way the
 * resolved path comes back on `session.sessionFile` — this function never
 * invents one.
 *
 * `resume` continues the most recent transcript for `cwd` instead of opening a
 * blank one. That is what a long-lived session (the orchestrator) wants: a
 * daemon restart should not erase its memory of what it has already escalated.
 * A worker wants the opposite, so it stays off by default.
 *
 * @throws if the peer dependency is absent, naming it — a missing harness is a
 * deployment mistake, and a stack trace about a failed dynamic import sends the
 * reader looking in the wrong place.
 */
export async function createSession(opts: {
  cwd: string;
  sessionDir?: string;
  model?: string;
  resume?: boolean;
}): Promise<AgentSessionLike> {
  let loaded: unknown;
  try {
    // Dynamic import is load-bearing, not laziness: the harness is an optional
    // peer dependency that is absent when this package is type-checked or
    // published, so a static import would fail the build it must survive.
    loaded = await import(OMP_PACKAGE as string);
  } catch (cause) {
    throw new Error(
      `omp-conductor could not load its peer dependency ${OMP_PACKAGE}. Install it alongside omp-conductor (it is deliberately not bundled, so the dispatcher runs the same harness build as the operator).`,
      { cause },
    );
  }
  // Narrowed onto a `const` so the checks survive into the closure below.
  const namespace: unknown = loaded;
  if (namespace === null || typeof namespace !== "object") {
    throw new Error(
      `${OMP_PACKAGE} loaded but is not a module namespace; omp-conductor needs a harness build that still exposes the SDK entrypoint.`,
    );
  }
  const missing = REQUIRED_EXPORTS.filter(
    (name) => typeof Reflect.get(namespace, name) !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `${OMP_PACKAGE} loaded but exports no ${missing.join(", ")}; omp-conductor needs a harness build exposing createAgentSession (the session), SessionManager (a file-backed transcript) and AgentRegistry (so concurrent workers do not collide on the "Main" identity).`,
    );
  }
  // The one unchecked cast in this package: the shape is verified immediately
  // above, but only the harness itself can name its own types.
  const mod = namespace as unknown as OmpModule;

  // File-backed on purpose. `SessionManager.inMemory()` leaves
  // `session.sessionFile` undefined, and once the worktree is gone the
  // transcript is the only record of what the worker actually did.
  const sessionManager = await openSessionManager(mod, opts);

  const created = await mod.createAgentSession({
    cwd: opts.cwd,
    // A raw pattern rather than a resolved Model: the harness resolves it
    // after extensions load, so we never have to import its model registry.
    ...(opts.model === undefined ? {} : { modelPattern: opts.model }),
    sessionManager,
    // A private registry per session, never the process-global default: that
    // one admits only one "Main" identity per generation, so a second session
    // sharing it fails to start. The daemon runs `maxConcurrentWorkers`
    // (2 by default) workers at once, which makes this the normal path.
    agentRegistry: new mod.AgentRegistry(),
  });
  const raw = asRawSession(created);
  // Surfaced rather than swallowed: this is how a quiet downgrade to a weaker
  // model reaches the daemon's log instead of only the operator's surprise.
  const fallback =
    created !== null && typeof created === "object"
      ? Reflect.get(created, "modelFallbackMessage")
      : undefined;
  const modelFallbackMessage =
    typeof fallback === "string" && fallback !== "" ? fallback : undefined;

  // One real subscription fanned out per event type, so N `on()` calls cost one
  // listener on the harness stream and unknown event types cost nothing.
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  raw.subscribe((event) => {
    const type = (event as { type?: unknown } | null | undefined)?.type;
    if (typeof type !== "string") return;
    for (const cb of handlers.get(type) ?? []) cb(event);
    for (const cb of handlers.get("*") ?? []) cb(event);
  });

  const session: AgentSessionLike = {
    prompt: (text, promptOpts) => raw.prompt(text, promptOpts),
    on(event, cb) {
      const list = handlers.get(event);
      if (list) list.push(cb);
      else handlers.set(event, [cb]);
    },
    abort() {
      raw.abort();
    },
    // The path the session actually opened, never one we asked for: the
    // arm/monitor tooling reads this file as proof of activity, so a path
    // nothing ever writes to is worse than no path at all.
    get sessionFile() {
      return raw.sessionFile;
    },
    ...(modelFallbackMessage === undefined ? {} : { modelFallbackMessage }),
  };

  disposers.set(session, async () => {
    await raw.dispose?.();
  });
  return session;
}

/**
 * Release a session's harness-side resources. Safe to call on any
 * {@link AgentSessionLike} — a hand-rolled fake, or a harness build with no
 * `dispose()`, is a no-op rather than a crash during teardown.
 */
export async function disposeSession(session: AgentSessionLike): Promise<void> {
  await disposers.get(session)?.();
  disposers.delete(session);
}

/**
 * Pick the session manager for one `createSession` call.
 *
 * On the resume path the harness's own `continueRecent` decides whether there
 * is anything to continue, so this never has to list or stat transcripts
 * itself. `create` is the fallback for two cases: a harness build predating
 * `continueRecent`, and a resume that failed outright.
 */
async function openSessionManager(
  mod: OmpModule,
  opts: { cwd: string; sessionDir?: string; resume?: boolean },
): Promise<unknown> {
  const fresh = (): unknown =>
    opts.sessionDir === undefined
      ? mod.SessionManager.create(opts.cwd)
      : mod.SessionManager.create(opts.cwd, opts.sessionDir);

  if (opts.resume !== true || typeof mod.SessionManager.continueRecent !== "function") return fresh();
  try {
    const resumed = await mod.SessionManager.continueRecent(opts.cwd, opts.sessionDir);
    if (resumed !== null && typeof resumed === "object") return resumed;
  } catch {
    // ponytail: an unreadable newest transcript costs this session its memory
    // rather than blocking startup — a conductor that will not boot because an
    // old .jsonl is corrupt is worse than one that starts forgetful. Upgrade
    // path: walk `SessionManager.list(cwd)` for the newest readable transcript.
  }
  return fresh();
}

/**
 * Unwrap whatever `createAgentSession` handed back. It returns
 * `{ session, … }` today; a bare session is accepted too so a minor SDK change
 * in either direction fails loudly here instead of as `undefined is not a
 * function` three events later.
 */
function asRawSession(created: unknown): RawSession {
  const wrapper = created as { session?: unknown } | null | undefined;
  const candidate = (
    wrapper && typeof wrapper === "object" && "session" in wrapper ? wrapper.session : created
  ) as RawSession | null | undefined;
  if (
    !candidate ||
    typeof candidate.prompt !== "function" ||
    typeof candidate.subscribe !== "function" ||
    typeof candidate.abort !== "function"
  ) {
    throw new Error(
      `${OMP_PACKAGE} returned an unrecognised session from createAgentSession(); omp-conductor needs { prompt, subscribe, abort }.`,
    );
  }
  return candidate;
}
