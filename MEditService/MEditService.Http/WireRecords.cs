using System.Text.Json;
using MEditService.Commands.Edits;

namespace MEditService.Http;

public record FilterRequest(string Sql, string Source);
public record FilterResponse(string? Sql, string? Source);

/// <summary>ADR-0015 invariant 3: the answer to "did the projection reach at least N?" — Sequence
/// is the value observed at the moment of that answer, not necessarily equal to the awaited
/// bound.</summary>
public record SequenceAwaitResponse(bool Reached, long Sequence);

/// <summary>Applied or refusal (ADR-0019): failures already ride LoadOrderStatus, and a repair
/// offer is a question-open notification, so this names neither.</summary>
public record LoadOrderResponse(bool Applied, long Version = 0);
// ADR-0013: Mod Management's snapshot. InstanceRoot (ADR-0009) must be the MO2 instance rather
// than anything wider, because Origin is a mod folder name unique only within one.
public record LoadOrderRequest(
    IReadOnlyList<LoadOrderPlugin> Plugins, string GameDirectory, string InstanceRoot, string GameRelease = "Fallout4");
// Slot is null when no plugins.txt line names it. Enabled and Winning are nullable only so an
// omitted field is detectable: a plain bool would bind a missing property to false, quietly
// making every plugin non-participating.
public record LoadOrderPlugin(string Name, string Path, string Origin, int? Slot, bool? Enabled, bool? Winning);

// ADR-0009 invariant 5: the Refresh rebuild's own request, keyed on the instance as
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
    JsonElement? Value = null);

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

/// <summary>A record and the plugin holding it, named by filename and origin (ADR-0012 invariant 1):
/// one filename can be in two mods, each holding the record.</summary>
public record RecordAddress(string FormKey, string Plugin, string Origin);

/// <summary>A record of the selection that wrote nothing: the typed refusal, and the message naming
/// the way out.</summary>
public record RecordAddressRefusal(RecordAddress Record, RecordEditRefusal Refusal, string Message);

public record RecordDeleteRequest(IReadOnlyList<RecordAddress> Records);

/// <summary>Applied or refusal, per record (ADR-0019 invariant 4): a refusal is an item of the
/// answer, never the status of the call.</summary>
public record RecordDeleteResponse(IReadOnlyList<RecordAddress> Applied, IReadOnlyList<RecordAddressRefusal> Refused);

// ADR-0007: xEdit's "Copy as Override Into…" / "Copy as New Record Into…". The route's {formKey}
// names the record copied; both plugins travel as ADR-0012 compound identities.

public record RecordCopyAsOverrideRequest(string SourcePlugin, string SourceOrigin, string DestinationPlugin, string DestinationOrigin);

public record RecordCopyAsOverrideResponse(bool Applied, string FormKey);

/// <summary><see cref="RequestedFormKey"/> null means auto-allocate the next free local FormID
/// (both-refs collision-safe); non-null is xEdit's typed-FormID path.</summary>
public record RecordCopyAsNewRecordRequest(
    string SourcePlugin, string SourceOrigin, string DestinationPlugin, string DestinationOrigin, string? RequestedFormKey);

public record RecordCopyAsNewRecordResponse(bool Applied, string SourceFormKey, string NewFormKey);
