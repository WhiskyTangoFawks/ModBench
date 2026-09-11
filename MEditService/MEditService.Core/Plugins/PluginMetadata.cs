
namespace MEditService.Core.Plugins;

// One physical plugin copy the load order holds (ADR-0044). Participation and load-order
// membership are derived from LoadOrderIndex/Enabled/Winning, never stored, so a reconcile that
// moves a flag cannot leave a cached verdict behind.

// Origin (ADR-0036) is opaque here, never interpreted; record tables key on (form_key, origin,
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

/// <summary>A copy that could not be opened is a row in an error state (ADR-0044): the rest of the
/// load order is unaffected, and the reason is reported here rather than as a failed
/// reconcile.</summary>
public record PluginLoadFailure(string Name, string Origin, string Reason)
{
    /// <summary>Mutagen wraps a parse error naming the record, subrecord and offset several levels
    /// down the <see cref="Exception.InnerException"/> chain, so a bare message discards exactly
    /// that detail; this flattens the whole chain, outermost first.</summary>
    public static string ReasonFor(Exception ex)
    {
        var lines = new List<string>();
        for (Exception? current = ex; current is not null; current = current.InnerException)
            lines.Add($"{current.GetType().Name}: {current.Message}");
        return string.Join('\n', lines);
    }
}
