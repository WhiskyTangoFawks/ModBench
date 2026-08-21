namespace MEditService.Core.Source;

/// <summary>The phases <see cref="TrackService.TrackAsync"/> moves through, in order — enough to
/// narrate a mega-plugin's worst-case tens-of-seconds Track (AC4, #414 review F2) without a
/// literal percentage: <c>Idle</c> (nothing in flight), <c>Parsing</c> (deep-parsing each plugin —
/// <see cref="TrackProgress.RecordsTotal"/> is the plugin count, known up front), <c>Serializing</c>
/// (each plugin's whole tree through the whole-mod door, <see cref="TrackProgress.RecordsDone"/>
/// advancing one <i>plugin</i> at a time — #451 slice A: granularity coarsened from per-record to
/// per-plugin, since the whole-mod door serializes each plugin as one call with no per-record
/// progress callback of its own to observe), <c>Committing</c> (the git mechanics — not itself broken
/// into finer steps).</summary>
public enum TrackPhase
{
    Idle,
    Parsing,
    Serializing,
    Committing,
}

/// <summary>What <see cref="TrackService"/> can say about a Track in flight right now — the read
/// behind <c>GET /plugins/track/status</c>, polled alongside the still in-flight
/// <c>POST /plugins/track</c>, the same idiom <c>SessionStatus</c>/<c>GET /session/status</c>
/// already established for the session load. One shared instance on the singleton service, not
/// per-origin: Track is a single, deliberate user gesture — nothing today runs two at once, and
/// the AC only asks that a mega-plugin's own long Track narrates itself.
///
/// <para><see cref="RecordsDone"/>/<see cref="RecordsTotal"/> count <b>plugins</b>, not records, since
/// #451 slice A (see <see cref="TrackPhase"/>'s own doc comment) — the names survive unchanged because
/// nothing outside this class reads them today (grepped) and "plugins done/total" is the same shape
/// of fact "records done/total" was, just coarser.</para>
/// </summary>
public sealed record TrackProgress(string? Origin, TrackPhase Phase, int RecordsDone, int RecordsTotal)
{
    public static readonly TrackProgress Idle = new(null, TrackPhase.Idle, 0, 0);
}
