namespace MEditService.Core.Source;

/// <summary>The phases <see cref="TrackService.TrackAsync"/> moves through, in order — enough to
/// narrate a mega-plugin's worst-case tens-of-seconds Track (AC4, #414 review F2) without a
/// literal percentage: <c>Idle</c> (nothing in flight), <c>Parsing</c> (deep-parsing each plugin —
/// <see cref="TrackProgress.RecordsTotal"/> grows as each plugin's own count becomes known),
/// <c>Serializing</c> (per-record strip + codec write, <see cref="TrackProgress.RecordsDone"/>
/// advances one at a time), <c>Committing</c> (the git mechanics — not itself broken into finer
/// steps, since there is nothing per-record left to count there).</summary>
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
/// the AC only asks that a mega-plugin's own long Track narrates itself.</summary>
public sealed record TrackProgress(string? Origin, TrackPhase Phase, int RecordsDone, int RecordsTotal)
{
    public static readonly TrackProgress Idle = new(null, TrackPhase.Idle, 0, 0);
}
