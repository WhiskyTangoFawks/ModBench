using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Http;

public record FilterRequest(string Sql, string Source);
public record FilterResponse(string? Sql, string? Source);

/// <summary>Applied or refusal (ADR-0019): failures already ride LoadOrderStatus, so this names
/// none.</summary>
public record LoadOrderResponse(bool Applied, long Version = 0);
// ADR-0013: Mod Management's snapshot: every plugin, the active ones in load order and those loaded
// with no line. InstanceRoot: ADR-0009.
public record LoadOrderRequest(
    IReadOnlyList<LoadOrderPlugin> Plugins, IReadOnlyList<PluginAddress> Active,
    IReadOnlyList<PluginAddress> LoadedWithNoLine, string GameDirectory, string InstanceRoot,
    string GameRelease = "Fallout4");
public record LoadOrderPlugin(string Name, string Path, string Origin);

// ADR-0009: the Refresh rebuild's own request, keyed on the instance as
// LoadOrderRequest is.
public record RebuildIndexRequest(string InstanceRoot, string GameRelease = "Fallout4");

public record HealthResponse(string Status);

// ADR-0007: one edit on one plugin's copy, as the one envelope (ADR-0005). Value is a raw
// JsonElement: a value is whatever its schema says, so typing it here would re-declare the
// schema on the wire.
public record RecordEditRequest(
    string Plugin,
    string Origin,
    string Op,
    IReadOnlyList<PathHop> Path,
    [property: JsonConverter(typeof(KeepsJsonNullConverter))] JsonElement? Value = null);

/// <summary>An applied edit; <see cref="NewFormKey"/> is set by an edit of the FormID. A refusal is
/// ProblemDetails with refusal and path extensions, so a plain success check is correct (ADR-0019).</summary>
public record RecordEditResponse(bool Applied, string FormKey, string Path, string? NewFormKey = null);

// The three lifecycle gestures' wire shapes, on the same door (Plugin/Origin as the compound
// identity, refusals as ProblemDetails carrying the same `refusal` extension) Edit already
// established.

/// <summary><see cref="FormKey"/> null means auto-allocate the next free local FormID (both-refs
/// collision-safe); non-null is xEdit's typed-FormID path.</summary>
public record RecordCreateRequest(string Origin, string RecordType, string? EditorId, string? FormKey);

public record RecordCreateResponse(bool Applied, string FormKey, string RecordType);

/// <summary>A record and the plugin holding it, named by filename and origin (ADR-0012):
/// one filename can be in two mods, each holding the record.</summary>
public record RecordAddress(string FormKey, string Plugin, string Origin);

/// <summary>A record of the selection that wrote nothing: the typed refusal, and the message naming
/// the way out.</summary>
public record RecordAddressRefusal(RecordAddress Record, RecordEditRefusal Refusal, string Message);

public record RecordDeleteRequest(IReadOnlyList<RecordAddress> Records);

/// <summary>Applied or refusal, per record (ADR-0019): a refusal is an item of the
/// answer, never the status of the call.</summary>
public record RecordDeleteResponse(IReadOnlyList<RecordAddress> Applied, IReadOnlyList<RecordAddressRefusal> Refused);

/// <summary>Copy's Argument and Options (commands.md, Record, `copy`). <see cref="Replace"/> lets an
/// override copy over the one a destination holds; the surface supplies it once the user confirms.</summary>
public record RecordCopyRequest(
    IReadOnlyList<RecordAddress> Records, CopyMode Mode, IReadOnlyList<PluginAddress> Destinations, bool Replace = false);

/// <summary><see cref="NewFormKey"/> is the duplicate's, and null for an override.</summary>
public record RecordCopyLanded(RecordAddress Record, PluginAddress Destination, string? NewFormKey);

public record RecordCopyRefusal(RecordAddress Record, PluginAddress Destination, RecordEditRefusal Refusal, string Message);

/// <summary>Applied or refusal, per record and destination (ADR-0019).</summary>
public record RecordCopyResponse(IReadOnlyList<RecordCopyLanded> Applied, IReadOnlyList<RecordCopyRefusal> Refused);
