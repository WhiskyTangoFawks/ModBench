using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Commands.Edits;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

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
// Line: the place of the plugins.txt line naming its filename, null when none does.
internal sealed record LoadOrderPlugin(string Name, string Path, string Origin, PluginProviderRequest Provider, int? Line);

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

/// <summary>The changes an edit makes to plugin source, written nowhere: each move, then each document's
/// new text at its absolute path once moved. A refusal is ProblemDetails, as the edit's is.</summary>
internal sealed record RecordEditChangesResponse(
    string FormKey, string Path, IReadOnlyList<SourceMove> Moves, IReadOnlyList<DocumentChange> Documents, string? NewFormKey = null);

// The three lifecycle gestures' wire shapes, on the same door (Plugin/Origin as the compound
// identity, refusals as ProblemDetails carrying the same `refusal` extension) Edit already
// established.

/// <summary>Container is the FormKey, in the plugin the request names, of the record the new one goes into;
/// Position is an exterior cell's grid position, and only a worldspace takes one.</summary>
internal sealed record RecordCreateRequest(string Origin, string RecordType, string? Container = null, GridPosition? Position = null);

internal sealed record RecordCreateResponse(bool Applied, string FormKey, string RecordType);

/// <summary>A record and the plugin holding it (ADR-0012).</summary>
internal sealed record RecordAddress(string FormKey, string Plugin, string Origin);

/// <summary>A record of the selection that wrote nothing: the typed refusal, and the message naming
/// the way out.</summary>
internal sealed record RecordAddressRefusal(RecordAddress Item, RecordEditRefusal Refusal, string Message);

internal sealed record CompareRecordsRequest(IReadOnlyList<RecordCopy> Copies);

internal sealed record RecordDeleteRequest(IReadOnlyList<RecordAddress> Records);

/// <summary>Applied or refusal, per record (ADR-0019): a refusal is an item of the
/// answer, never the status of the call.</summary>
internal sealed record RecordDeleteResponse(IReadOnlyList<RecordAddress> Applied, IReadOnlyList<RecordAddressRefusal> Refused);

/// <summary>Copy's Argument and Options (commands.md, Record, `copy`). <see cref="Replace"/> lets an
/// override copy over the one a destination holds; the surface supplies it once the user confirms.</summary>
internal sealed record RecordCopyRequest(
    IReadOnlyList<RecordAddress> Records, CopyMode Mode, IReadOnlyList<PluginAddress> Destinations, bool Replace = false);

/// <summary><see cref="NewFormKey"/> is the duplicate's, and null for an override.</summary>
internal sealed record RecordCopyLanded(RecordAddress Record, PluginAddress Destination, string? NewFormKey);

internal sealed record RecordCopyItem(RecordAddress Record, PluginAddress Destination);

internal sealed record RecordCopyRefusal(RecordCopyItem Item, RecordEditRefusal Refusal, string Message);

internal sealed record RecordsWithChildrenRequest(IReadOnlyList<RecordAddress> Records);

internal sealed record ChildrenInDestinationsRequest(IReadOnlyList<RecordAddress> Records, IReadOnlyList<PluginAddress> Destinations);

/// <summary>The destinations that hold any of the record's child records, at any depth.</summary>
internal sealed record RecordChildHolders(RecordAddress Record, IReadOnlyList<PluginAddress> Destinations);

/// <summary>Applied or refusal, per record and destination (ADR-0019).</summary>
internal sealed record RecordCopyResponse(IReadOnlyList<RecordCopyLanded> Applied, IReadOnlyList<RecordCopyRefusal> Refused);
