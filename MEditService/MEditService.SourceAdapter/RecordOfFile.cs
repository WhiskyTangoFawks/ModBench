using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>What a file holds. <see cref="HoldsNone"/> is the layout's answer, from the path alone.</summary>
public abstract record RecordOfFile
{
    private RecordOfFile()
    {
    }

    public sealed record Holds(RecordAt Record) : RecordOfFile;

    public sealed record HoldsNone : RecordOfFile;

    public sealed record Refused(string Why) : RecordOfFile;
}
