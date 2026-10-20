namespace MEditService.PluginAdapter;

public static class LoadFailureReason
{
    /// <summary>Mutagen wraps a parse error naming the record, subrecord and offset several levels
    /// down the <see cref="Exception.InnerException"/> chain, so a bare message discards exactly
    /// that detail; this flattens the whole chain, outermost first.</summary>
    public static string Of(Exception ex)
    {
        var lines = new List<string>();
        for (Exception? current = ex; current is not null; current = current.InnerException)
            lines.Add($"{current.GetType().Name}: {current.Message}");
        return string.Join('\n', lines);
    }
}
