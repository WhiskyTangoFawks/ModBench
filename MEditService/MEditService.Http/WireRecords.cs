using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Commands;
using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;

namespace MEditService.Http;

internal sealed record FilterRequest(string Sql, string Source);
internal sealed record FilterResponse(string? Sql, string? Source);

internal sealed record SelectRequest(string Sql);
internal sealed record SelectResponse(IReadOnlyList<JsonElement> Rows);
internal sealed record ResolveNamesRequest(IReadOnlyList<NameQuery> Names);
internal sealed record ResolveNamesResponse(IReadOnlyList<NamedObject> Named);

/// <summary>Applied or refusal (ADR-0019): failures already ride LoadOrderStatus, so this names
/// none.</summary>
internal sealed record LoadOrderResponse(bool Applied, long Version = 0);
// Mod Management's snapshot (ADR-0013). InstanceRoot: one index file per instance, inside the instance root (ADR-0010).
internal sealed record LoadOrderRequest(
    IReadOnlyList<LoadOrderPlugin> Plugins, IReadOnlyList<PluginAddress> Active,
    IReadOnlyList<PluginAddress> LoadedWithNoLine, IReadOnlyList<StampedFile> Archives, IReadOnlyList<StampedFile> StringsFiles,
    IReadOnlyList<PluginPlace> Places, string GameDirectory, string InstanceRoot, string GameRelease, string StringsLanguage, IReadOnlyList<ModByFolder> Mods, string StatCache);
internal sealed record LoadOrderPlugin(
    string Name, string Path, string Origin, PluginProviderRequest Provider, int? Line, bool LineNamesIt, IReadOnlyList<StampedFile> Archives,
    IReadOnlyList<StampedFile> StringsFiles);

[JsonConverter(typeof(JsonStringEnumConverter))]
internal enum PluginProviderKind { Mod, Game, None }

internal sealed record PluginProviderRequest(PluginProviderKind Kind, string? Mod = null, string? Folder = null, string? SourceFolder = null)
{
    internal PluginProvider? ToProvider() => Kind switch
    {
        PluginProviderKind.Game when Mod is null && Folder is null && SourceFolder is null => PluginProvider.Game,
        PluginProviderKind.None when Mod is null && Folder is null && SourceFolder is null => PluginProvider.NoMod,
        PluginProviderKind.Mod when !string.IsNullOrEmpty(Mod) && !string.IsNullOrEmpty(Folder) && SourceFolder is null or { Length: > 0 } =>
            new PluginProvider.FromMod(Mod, Folder, SourceFolder),
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
    [property: JsonConverter(typeof(KeepsJsonNullConverter))] JsonElement? Value = null)
{
    internal EditValue? EditedValue => Value switch
    {
        null => null,
        { ValueKind: JsonValueKind.Number } number when number.TryGetInt64(out _) => new(EditValueKind.WholeNumber, number.GetRawText()),
        { ValueKind: JsonValueKind.String } text => new(EditValueKind.Text, text.GetRawText(), text.GetString()),
        { } other => new(EditValueKind.Other, other.GetRawText()),
    };
}

internal sealed record RecordEditChangesRequest(RecordEditRequest Edit);

/// <summary>Documents are the unsaved texts of every dirty plugin-source document.</summary>
internal sealed record UnsavedDocumentsRequest(IReadOnlyList<DocumentChange> Documents);

// The three lifecycle gestures' wire shapes, on the same door (Plugin/Origin as the compound
// identity, refusals as ProblemDetails carrying the same `refusal` extension) Edit already
// established.

/// <summary>Container is the FormKey, in the plugin the request names, of the record the new one goes into;
/// Position is an exterior cell's grid position, and only a worldspace takes one.</summary>
internal sealed record RecordCreateChangesRequest(
    string Origin, string RecordType, string? Container = null, GridPosition? Position = null);

internal sealed record CompareRecordsRequest(IReadOnlyList<RecordCopy> Copies);

/// <summary>A copy of the comparison that no plugin gave: RecordGone when no registered
/// plugin holds its record at all, otherwise only the plugin it names lacks it.</summary>
internal sealed record CopyMissing(string FormKey, PluginAddress Plugin, CopyMissingReason Reason, string Message);

/// <summary>The comparison, or the copies that stopped it (ADR-0019): Compare is null exactly
/// when Missing is not empty.</summary>
internal sealed record CompareRecordsResponse(CompareResult? Compare, IReadOnlyList<CopyMissing> Missing);

internal sealed record RecordDeleteChangesRequest(IReadOnlyList<RecordAddress> Records);

/// <summary>A script's copy of one record into one destination.</summary>
internal sealed record ScriptCopyRequest(RecordAddress Record, CopyMode Mode, PluginAddress Destination, bool Replace = false);

/// <summary>Copy's Argument and Options (commands.md, Record, `copy`). <see cref="Replace"/> lets an override copy over the one a destination holds.</summary>
internal sealed record RecordCopyRequest(
    IReadOnlyList<RecordAddress> Records, CopyMode Mode, IReadOnlyList<PluginAddress> Destinations, bool Replace = false);
