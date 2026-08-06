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
  /** Transcript path, so a human can read what the worker actually did. */
  sessionFile?: string;
}

/** The one function this shim calls on the SDK module. */
interface OmpModule {
  createAgentSession(opts: unknown): Promise<unknown>;
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
 * Start one omp coding session rooted at `cwd`.
 *
 * @throws if the peer dependency is absent, naming it — a missing harness is a
 * deployment mistake, and a stack trace about a failed dynamic import sends the
 * reader looking in the wrong place.
 */
export async function createSession(opts: {
  cwd: string;
  sessionFile?: string;
  model?: string;
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
  if (
    loaded === null ||
    typeof loaded !== "object" ||
    typeof Reflect.get(loaded, "createAgentSession") !== "function"
  ) {
    throw new Error(
      `${OMP_PACKAGE} loaded but exports no createAgentSession(); omp-conductor needs a harness build that still exposes the SDK entrypoint.`,
    );
  }
  // The one unchecked cast in this package: the shape is verified immediately
  // above, but only the harness itself can name its own types.
  const mod = loaded as unknown as OmpModule;

  const raw = asRawSession(
    await mod.createAgentSession({
      cwd: opts.cwd,
      // A raw pattern rather than a resolved Model: the harness resolves it
      // after extensions load, so we never have to import its model registry.
      ...(opts.model === undefined ? {} : { modelPattern: opts.model }),
      // ponytail: the harness owns its sessions root and has no `sessionFile`
      // option today, so this is a forward-compatible hint only. The path we
      // report back below is whatever the session actually chose. Upgrade path:
      // pass a `sessionManager` once we need transcripts at a fixed path.
      ...(opts.sessionFile === undefined ? {} : { sessionFile: opts.sessionFile }),
    }),
  );

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
    get sessionFile() {
      return raw.sessionFile ?? opts.sessionFile;
    },
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
