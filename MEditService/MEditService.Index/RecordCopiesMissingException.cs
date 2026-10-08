using MEditService.Index.Queries;

namespace MEditService.Index;

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

    internal RecordCopiesMissingException(IReadOnlyList<RecordCopy> missing)
        : this($"Copies not found: {string.Join("; ", missing.Select(c => $"{c.FormKey} in {c.Plugin.Name} ({c.Plugin.Origin})"))}.")
    {
    }
}
