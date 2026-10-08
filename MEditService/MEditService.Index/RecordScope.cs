namespace MEditService.Index;

/// <summary>Which rows a read of records sees: the active plugins' (ADR-0012), or every registered
/// plugin's.</summary>
internal sealed record RecordScope(string Records, string SideTables)
{
    internal static readonly RecordScope Active = new("records", "");

    internal static readonly RecordScope EveryRegisteredPlugin =
        new(TableDdlBuilder.PluginRecordsView, $"{TableDdlBuilder.MirrorSchema}.");

    internal string Held => NavigatorSql.HeldIn(SideTables);

    internal string ContainerChild => $"{SideTables}container_child";
}
