using MEditService.Queries;

namespace MEditService.Http;

public record PluginResponse(
    string Name,
    string Path,
    // ADR-0013: the plugins.txt slot past the forced masters, or null when no line names this
    // copy; record-level LoadOrderIndex values are sort keys and put such a copy last.
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable,
    // Participates (ADR-0013): Registration.Participates, as the wire sees it — the only copies
    // that compete for winner or count in a conflict.
    bool Participates,
    string Origin,
    // MasterIssues (ADR-0012): this plugin's own unresolvable masters, never a transitive fact.
    // Empty rather than null when every master resolved.
    IReadOnlyList<MasterIssue> MasterIssues,
    // InLoadOrder (ADR-0013 invariant 3): derived — the winning copy of a listed name, enabled
    // or not. False for an overridden plugin or an unlisted file. See PluginMetadata.InLoadOrder.
    bool InLoadOrder,
    // Enabled / Winning (ADR-0013): the two registration facts beside the slot, as Mod Management
    // stated them — what lets a row say *why* it does not participate (disabled, or overridden).
    bool Enabled,
    bool Winning,
    // HasMatchingRecords (plugins.md): a record filter prunes records, never a
    // plugin row, so this is what a caller uses to decide whether to offer a chevron. Defaults
    // to true: only the plugin listing answers inside a filter.
    bool HasMatchingRecords = true,
    // IsTracked (ADR-0007 invariant 3): this copy's rows came from its source tree, as the Index
    // holds it. False with no mod folder at all (IsImmutable tells the two apart).
    bool IsTracked = false,
    // HasParseFailure: whether this plugin holds a record Mutagen could not read. The plugin-level
    // load failure (LoadOrderResponse.Failures) stays its own channel for a file that never indexed.
    bool HasParseFailure = false)
{
    /// <summary>One row on the wire: the read side's answer, flattened.</summary>
    public static PluginResponse Of(PluginRow row)
    {
        var copy = row.Copy;
        var registration = copy.Registration;
        return new(copy.Name, copy.Path, copy.Slot, row.Content.IsLight, row.Content.IsMaster,
            row.Content.Masters, row.Content.RecordCount, copy.IsImmutable, registration.Participates,
            copy.Origin, row.MasterIssues, registration.InLoadOrder, copy.Enabled, copy.Winning,
            row.HasMatchingRecords, row.IsTracked,
            row.HasParseFailure);
    }
}
