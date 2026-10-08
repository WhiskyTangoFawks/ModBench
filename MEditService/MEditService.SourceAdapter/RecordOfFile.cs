using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>What a file holds: the record whose own document it is, none by the layout, or a refusal saying why it
/// cannot be read as one.</summary>
public abstract record RecordOfFile
{
    private RecordOfFile()
    {
    }

    public sealed record Holds(RecordAt Record) : RecordOfFile;

    public sealed record HoldsNone : RecordOfFile;

    public sealed record Refused(string Why) : RecordOfFile;
}
