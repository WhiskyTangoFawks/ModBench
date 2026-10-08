namespace MEditService.Index;

/// <summary>Which rows a read of records sees: the active plugins' (ADR-0012), or every registered
/// plugin's.</summary>
internal sealed record RecordScope(string Records, string SideTables, string Referrers)
{
    internal static readonly RecordScope Active = new("records", "", "form_references fr");

    internal static readonly RecordScope EveryRegisteredPlugin = new(
        TableDdlBuilder.PluginRecordsView,
        $"{TableDdlBuilder.MirrorSchema}.",
        $"{TableDdlBuilder.MirrorSchema}.form_references fr {TableDdlBuilder.RegisteredJoin("fr", "source_plugin", "source_origin")}");

    internal string Held => NavigatorSql.HeldIn(SideTables);

    internal string ContainerChild => $"{SideTables}container_child";
}
