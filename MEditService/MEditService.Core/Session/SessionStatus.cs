namespace MEditService.Core.Session;

/// <summary>
/// Where the single active session is in its lifecycle (#274 / ADR-0035). Loading is a state a
/// caller can observe and act on, not an internal phase — a plugin's records are browsable the
/// moment it is indexed, well before the load finishes.
/// </summary>
public enum SessionState
{
    /// <summary>No session at all — never loaded, unloaded, or the load failed outright.</summary>
    None,

    /// <summary>Plugins are still being opened and indexed. Everything already indexed is
    /// queryable and correct *for that plugin*; anything comparing plugins is not yet settled.</summary>
    Loading,

    /// <summary>Every plugin has been indexed and the winner sweep has run.</summary>
    Ready,
}

/// <summary>One plugin the session has finished indexing. Carries origin as well as filename because
/// a plugin is identified by <c>(origin, plugin)</c> together (#271 / #275) — two copies of one
/// filename can be loaded at once, and a bare name cannot say which one landed.</summary>
public sealed record IndexedPlugin(string Name, string Origin);

/// <summary>
/// What the session can honestly say about itself right now (#274 / ADR-0035). Exists so that an
/// absent conflict badge is never mistakable for "no conflict": a caller reading
/// <see cref="ConflictsComputed"/> false knows nothing has looked yet.
/// </summary>
/// <param name="TotalPlugins">How many plugins this load set out to open — the denominator for
/// progress. Plugins that fail to open still count toward it.</param>
/// <param name="IndexedPlugins">Those whose indexing has completed, in the order they landed. A
/// plugin appears here only once it is wholly queryable.</param>
/// <param name="ConflictsComputed">Whether the winner sweep has run since the last change to the
/// indexed set. Distinct from <see cref="State"/> being <see cref="SessionState.Ready"/>, though the
/// two coincide today: the sweep is whole-set, so ADR-0035's live mutations (reorder, enable,
/// disable) will leave a Ready session with stale winners until it is re-run. A caller deciding
/// whether to render conflict information must read this one, not the state.</param>
/// <param name="Failures">Plugins that could not be opened or indexed, as they are discovered —
/// not held back until the load finishes (ADR-0026).</param>
public sealed record SessionStatus(
    SessionState State,
    int TotalPlugins,
    IReadOnlyList<IndexedPlugin> IndexedPlugins,
    bool ConflictsComputed,
    IReadOnlyList<PluginLoadFailure> Failures)
{
    public static readonly SessionStatus None =
        new(SessionState.None, 0, [], ConflictsComputed: false, []);
}
