using System.Text.Json.Serialization;
using MEditService.Index.Queries;

namespace MEditService.Index;

/// <summary><see cref="RecordGone"/> when no registered plugin holds the record at all, otherwise only the
/// plugin the copy names lacks it.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CopyMissingReason { RecordGone, NotInPlugin }

public sealed record MissingCopy(RecordCopy Copy, CopyMissingReason Reason, string Message);

public sealed class RecordCopiesMissingException : Exception
{
    internal RecordCopiesMissingException()
    {
    }

    internal RecordCopiesMissingException(string message) : base(message)
    {
    }

    internal RecordCopiesMissingException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal RecordCopiesMissingException(IReadOnlyList<MissingCopy> missing)
        : this($"Copies not found: {string.Join("; ", missing.Select(m => $"{m.Copy.FormKey} in {m.Copy.Plugin.Name} ({m.Copy.Plugin.Origin})"))}.")
    {
        Missing = missing;
    }

    /// <summary>The copies no plugin gave, in the order given.</summary>
    public IReadOnlyList<MissingCopy> Missing { get; } = [];
}
