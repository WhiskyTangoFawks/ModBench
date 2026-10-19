using MEditService.Commands.Edits;

namespace MEditService.Commands;

/// <summary>Why a gesture on one record wrote nothing, and the message naming the way out. Path is the edited path.</summary>
public sealed record RecordEditRefused(RecordEditRefusal Refusal, string Message, string? Path = null);

/// <summary>The record a script's write made or left: the new FormKey of a copy as new or a create, otherwise the
/// FormKey the copy keeps.</summary>
public sealed record RecordWritten(string FormKey);
