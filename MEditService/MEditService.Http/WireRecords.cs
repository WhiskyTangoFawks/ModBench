using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Http;

public record FilterRequest(string Sql);
public record FilterResponse(string? Sql);

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
// making every copy non-participating.
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

/// <summary>The success shape for an applied edit. A refusal is ProblemDetails carrying refusal
/// and path extensions instead, so an HTTP client's ordinary success check is also the correct
/// check (ADR-0019).</summary>
public record RecordEditResponse(bool Applied, string FormKey, string Path);

// The three lifecycle gestures' wire shapes, on the same door (Plugin/Origin as the compound
// identity, refusals as ProblemDetails carrying the same `refusal` extension) Edit already
// established.

/// <summary><see cref="FormKey"/> null means auto-allocate the next free local FormID (both-refs
/// collision-safe); non-null is xEdit's typed-FormID path.</summary>
public record RecordCreateRequest(string Origin, string RecordType, string? EditorId, string? FormKey);

public record RecordCreateResponse(bool Applied, string FormKey, string RecordType);

/// <summary>One record in one plugin copy: a selection names each of its records by both
/// (ADR-0012 invariant 1).</summary>
public record RecordAddress(string FormKey, string Plugin, string Origin);

/// <summary>A record of the selection that wrote nothing: the typed refusal, and the message naming
/// the way out.</summary>
public record RecordAddressRefusal(RecordAddress Record, RecordEditRefusal Refusal, string Message);

public record RecordDeleteRequest(IReadOnlyList<RecordAddress> Records);

/// <summary>Applied or refusal, per record (ADR-0019 invariant 4): a refusal is an item of the
/// answer, never the status of the call.</summary>
public record RecordDeleteResponse(IReadOnlyList<RecordAddress> Applied, IReadOnlyList<RecordAddressRefusal> Refused);

/// <summary><see cref="NewFormKey"/> null means auto-allocate; non-null is xEdit's typed-FormID
/// renumber path.</summary>
public record RecordRenumberRequest(string Plugin, string Origin, string? NewFormKey);

public record RecordRenumberResponse(bool Applied, string OldFormKey, string NewFormKey);

/// <summary>The Renumber gesture's FormID input box's suggested default (<c>PeekNextFreeFormKeyHandler.PeekNextFreeFormKey</c>).</summary>
public record NextFreeFormKeyResponse(string FormKey);

// ADR-0007: xEdit's "Copy as Override Into…" / "Copy as New Record Into…". The route's {formKey}
// names the record copied; both plugins travel as ADR-0012 compound identities.

public record RecordCopyAsOverrideRequest(string SourcePlugin, string SourceOrigin, string DestinationPlugin, string DestinationOrigin);

public record RecordCopyAsOverrideResponse(bool Applied, string FormKey);

/// <summary><see cref="RequestedFormKey"/> null means auto-allocate the next free local FormID
/// (both-refs collision-safe); non-null is xEdit's typed-FormID path.</summary>
public record RecordCopyAsNewRecordRequest(
    string SourcePlugin, string SourceOrigin, string DestinationPlugin, string DestinationOrigin, string? RequestedFormKey);

public record RecordCopyAsNewRecordResponse(bool Applied, string SourceFormKey, string NewFormKey);
