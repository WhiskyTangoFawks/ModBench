using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.Index.Queries;
using MEditService.LoadOrder;

namespace MEditService.Http;

internal sealed record FilterRequest(string Sql, string Source);
internal sealed record FilterResponse(string? Sql, string? Source);

/// <summary>Applied or refusal (ADR-0019): failures already ride LoadOrderStatus, so this names
/// none.</summary>
internal sealed record LoadOrderResponse(bool Applied, long Version = 0);
// Mod Management's snapshot (ADR-0013). InstanceRoot: one index file per instance, inside the instance root (ADR-0010).
internal sealed record LoadOrderRequest(
    IReadOnlyList<LoadOrderPlugin> Plugins, IReadOnlyList<PluginAddress> Active,
    IReadOnlyList<PluginAddress> LoadedWithNoLine, string GameDirectory, string InstanceRoot,
    string GameRelease);
internal sealed record LoadOrderPlugin(string Name, string Path, string Origin, PluginProviderRequest Provider, int? Line, bool LineNamesIt);

[JsonConverter(typeof(JsonStringEnumConverter))]
internal enum PluginProviderKind { Mod, Game, None }

// Only Kind Mod has a Mod and a Folder.
internal sealed record PluginProviderRequest(PluginProviderKind Kind, string? Mod = null, string? Folder = null)
{
    internal PluginProvider? ToProvider() => Kind switch
    {
        PluginProviderKind.Game when Mod is null && Folder is null => PluginProvider.Game,
        PluginProviderKind.None when Mod is null && Folder is null => PluginProvider.NoMod,
        PluginProviderKind.Mod when !string.IsNullOrEmpty(Mod) && !string.IsNullOrEmpty(Folder) =>
            new PluginProvider.FromMod(Mod, Folder),
        _ => null,
    };
}

// The Refresh rebuild's own request (ADR-0010), keyed on the instance as
// LoadOrderRequest is.
internal sealed record RebuildIndexRequest(string InstanceRoot, string GameRelease);

internal sealed record HealthResponse(string Status);

// One edit on one plugin's copy, as the one envelope (ADR-0005). Value is a raw
// JsonElement: a value is whatever its schema says, so typing it here would re-declare the
// schema on the wire.
internal sealed record RecordEditRequest(
    string Plugin,
    string Origin,
    string Op,
    IReadOnlyList<PathHop> Path,
    [property: JsonConverter(typeof(KeepsJsonNullConverter))] JsonElement? Value = null);

/// <summary>An edit asked for the changes it makes, given <see cref="Text"/>, the current text of the
/// document carrying the record.</summary>
internal sealed record RecordEditChangesRequest(RecordEditRequest Edit, string Text);

/// <summary>The changes an edit makes to plugin source, written nowhere: each move, then each deletion,
/// then each document's new text at its absolute path once moved. A refusal is ProblemDetails, as the edit's is.</summary>
internal sealed record RecordEditChangesResponse(
    string FormKey, string Path, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents,
    string? NewFormKey = null)
{
    internal static RecordEditChangesResponse Of(string formKey, string path, RecordEditChanges answer) =>
        new(formKey, path,
            [.. answer.Changes.Moves.Select(move => new SourceMove(move.From, move.To))],
            answer.Changes.Deletions,
            [.. answer.Changes.Documents.Select(document => new DocumentChange(document.Path, document.Text))],
            answer.Outcome.NewFormKey);
}

/// <summary>A file or folder an edit moves, by absolute path.</summary>
internal sealed record SourceMove(string From, string To);

/// <summary>A document's new text at its absolute path once every move is made.</summary>
internal sealed record DocumentChange(string Path, string Text);

// The three lifecycle gestures' wire shapes, on the same door (Plugin/Origin as the compound
// identity, refusals as ProblemDetails carrying the same `refusal` extension) Edit already
// established.

/// <summary>Container is the FormKey, in the plugin the request names, of the record the new one goes into;
/// Position is an exterior cell's grid position, and only a worldspace takes one. Documents are unsaved texts.</summary>
internal sealed record RecordCreateChangesRequest(
    string Origin, string RecordType, string? Container = null, GridPosition? Position = null, IReadOnlyList<DocumentChange>? Documents = null);

/// <summary>The changes creating a record makes to plugin source, written nowhere, as an edit's are.</summary>
internal sealed record RecordCreateChangesResponse(
    string FormKey, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents)
{
    internal static RecordCreateChangesResponse Of(string formKey, RecordEditChanges answer) =>
        new(formKey,
            [.. answer.Changes.Moves.Select(move => new SourceMove(move.From, move.To))],
            answer.Changes.Deletions,
            [.. answer.Changes.Documents.Select(document => new DocumentChange(document.Path, document.Text))]);
}

/// <summary>A record and the plugin holding it (ADR-0012).</summary>
internal sealed record RecordAddress(string FormKey, string Plugin, string Origin);

/// <summary>A record of the selection that wrote nothing: the typed refusal, and the message naming
/// the way out.</summary>
internal sealed record RecordAddressRefusal(RecordAddress Item, RecordEditRefusal Refusal, string Message);

internal sealed record CompareRecordsRequest(IReadOnlyList<RecordCopy> Copies);

/// <summary>A copy of the comparison that no plugin gave: RecordGone when no registered
/// plugin holds its record at all, otherwise only the plugin it names lacks it.</summary>
internal sealed record CopyMissing(string FormKey, PluginAddress Plugin, CopyMissingReason Reason, string Message);

/// <summary>The comparison, or the copies that stopped it (ADR-0019): Compare is null exactly
/// when Missing is not empty.</summary>
internal sealed record CompareRecordsResponse(CompareResult? Compare, IReadOnlyList<CopyMissing> Missing);

/// <summary>Records to delete, and the unsaved text of the documents that stand in for their files.</summary>
internal sealed record RecordDeleteChangesRequest(IReadOnlyList<RecordAddress> Records, IReadOnlyList<DocumentChange> Documents);

/// <summary>The changes deleting one record makes to plugin source, written nowhere, as an edit's are.</summary>
internal sealed record RecordDeleteChanges(
    RecordAddress Record, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents);

/// <summary>Changes or refusal, per record (ADR-0019): a refusal is an item of the answer, never the status of the call.
/// Made in the order answered, the items leave the records deleted one after another.</summary>
internal sealed record RecordDeleteChangesResponse(IReadOnlyList<RecordDeleteChanges> Applied, IReadOnlyList<RecordAddressRefusal> Refused);

/// <summary>Copy's Argument and Options (commands.md, Record, `copy`), and the unsaved texts that stand in for
/// their files. <see cref="Replace"/> lets an override copy over the one a destination holds.</summary>
internal sealed record RecordCopyRequest(
    IReadOnlyList<RecordAddress> Records, CopyMode Mode, IReadOnlyList<PluginAddress> Destinations, bool Replace = false,
    IReadOnlyList<DocumentChange>? Documents = null);

/// <summary>The changes copying one record into one destination makes to plugin source, written nowhere, as an
/// edit's are.</summary>
internal sealed record RecordCopyChanges(
    RecordAddress Record, PluginAddress Destination, IReadOnlyList<SourceMove> Moves,
    IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents);

internal sealed record RecordCopyItem(RecordAddress Record, PluginAddress Destination);

internal sealed record RecordCopyRefusal(RecordCopyItem Item, RecordEditRefusal Refusal, string Message);

/// <summary>Changes or refusal, per record and destination (ADR-0019). Made in the order answered, the items leave
/// the records copied one after another.</summary>
internal sealed record RecordCopyChangesResponse(IReadOnlyList<RecordCopyChanges> Applied, IReadOnlyList<RecordCopyRefusal> Refused);
