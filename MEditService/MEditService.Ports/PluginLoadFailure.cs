namespace MEditService.Ports;

/// <summary>A plugin that could not be opened (ADR-0013 invariant 4), its reason reported here
/// rather than as a failed reconcile.</summary>
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
