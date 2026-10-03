using MEditService.Queries;

namespace MEditService.Http;

public record PluginResponse(
    string Name,
    string Path,
    // The load index (ADR-0013 invariant 3), null when the plugin is not active; record-level
    // LoadOrderIndex values are sort keys and put such a plugin last.
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    // IsBlueprint (plugins.md, Drag and drop, story 3): a blueprint plugin loads after every plugin
    // that is not one. False for every plugin of a game without blueprint plugins.
    bool IsBlueprint,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable,
    string Origin,
    // MasterIssues (ADR-0012 invariant 4): the masters in this plugin's header that are not active.
    // Null while the snapshot is not indexed: not yet checked, which is not no issues.
    IReadOnlyList<string>? MasterIssues,
    // InLoadOrder (ADR-0013 invariant 3).
    bool InLoadOrder,
    // HasMatchingRecords (plugins.md): a record filter prunes records, never a
    // plugin row, so this is what a caller uses to decide whether to offer a chevron. Defaults
    // to true: only the plugin listing answers inside a filter.
    bool HasMatchingRecords = true,
    // IsTracked (ADR-0007 invariant 3), as the Index holds it. False with no mod folder at all
    // (IsImmutable tells the two apart).
    bool IsTracked = false,
    // HasParseFailure: whether this plugin holds a record Mutagen could not read. The plugin-level
    // load failure (LoadOrderResponse.Failures) stays its own channel for a file that never indexed.
    bool HasParseFailure = false)
{
    /// <summary>One row on the wire: the read side's answer, flattened.</summary>
    public static PluginResponse Of(PluginRow row)
    {
        var plugin = row.Plugin;
        return new(plugin.Name, plugin.Path, row.LoadOrderIndex, row.Content.IsLight, row.Content.IsMaster,
            row.Content.IsBlueprint, row.Content.Masters, row.Content.RecordCount, row.IsImmutable,
            plugin.Origin, row.MasterIssues, row.LoadOrderIndex is not null,
            row.HasMatchingRecords, row.IsTracked,
            row.HasParseFailure);
    }
}
