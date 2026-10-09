namespace MEditService.Codec.Serialization;

/// <summary>What appending a child to a container's slot answers.</summary>
public abstract record ChildAppend
{
    private ChildAppend()
    {
    }

    /// <summary>The container's text with the child in it.</summary>
    public sealed record Appended(string Text) : ChildAppend;

    /// <summary>The single-record slot already holds <paramref name="HeldFormKey"/>.</summary>
    public sealed record SlotHeld(string Slot, string HeldFormKey) : ChildAppend;
}
