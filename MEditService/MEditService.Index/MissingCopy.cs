using System.Text.Json.Serialization;
using MEditService.Index.Queries;

namespace MEditService.Index;

/// <summary><see cref="RecordGone"/> when no registered plugin holds the record at all, otherwise only the
/// plugin the copy names lacks it.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CopyMissingReason { RecordGone, NotInPlugin }

public sealed record MissingCopy(RecordCopy Copy, CopyMissingReason Reason, string Message);
