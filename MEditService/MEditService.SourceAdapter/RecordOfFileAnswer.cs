using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>What a file holds. <see cref="HoldsNone"/> is the layout's answer, from the path alone.</summary>
public abstract record RecordOfFileAnswer
{
    private RecordOfFileAnswer()
    {
    }

    public sealed record Holds(RecordAt Record) : RecordOfFileAnswer;

    public sealed record HoldsNone : RecordOfFileAnswer
    {
        internal HoldsNone()
        {
        }
    }

    public sealed record Refused(string Why) : RecordOfFileAnswer;
}
