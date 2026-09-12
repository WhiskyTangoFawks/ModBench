
namespace MEditService.LoadOrder;

// One physical plugin copy the load order holds (ADR-0013). Participation and load-order
// membership are derived from LoadOrderIndex/Enabled/Winning, never stored, so a reconcile that
// moves a flag cannot leave a cached verdict behind.

// Origin (ADR-0012) is opaque here, never interpreted; record tables key on (form_key, origin,
// plugin), and every construction site must say which origin this is rather than fall back
// silently.

// LoadOrderIndex is the name's plugins.txt slot offset past the game's forced masters, null when no
// line names the file. A losing copy of a listed name carries the same slot as the winning one.

// IsForced: a vanilla master or Creation Club plugin the game loads regardless of plugins.txt —
// always resolved from the game directory, always participating, never editable.
public record PluginMetadata(
    string Name,
    string Path,
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsForced,
    string Origin,
    bool Enabled,
    bool Winning)
{
    public PluginKey Key => new(Name, Origin);

    public Registration Registration => new(LoadOrderIndex, Enabled, Winning);

    public PluginContent Content => new(IsLight, IsMaster, Masters, RecordCount);

    public bool Participates => Registration.Participates;

    /// <summary>What makes a bare filename a safe write target: plugins.txt cannot list a name
    /// twice, so at most one held copy per name is in the load order.</summary>
    public bool InLoadOrder => Registration.InLoadOrder;
}

/// <summary>What reading the file told the Index about a copy, which no registration carries. Read
/// once when the copy is opened; a copy that never opened has none.</summary>
public sealed record PluginContent(bool IsLight, bool IsMaster, IReadOnlyList<string> Masters, int RecordCount);
