namespace MEditService.Codec.Serialization;

/// <summary>A single-valued child slot, a worldspace's persistent cell or a cell's landscape, holds a
/// record other than the one that would take it.</summary>
public sealed class ChildSlotHeldByAnotherRecordException : InvalidOperationException
{
    public string? HeldFormKey { get; }

    public ChildSlotHeldByAnotherRecordException(string parentType, string slotName, string heldFormKey, string incomingFormKey)
        : base($"{parentType}.{slotName} already holds {heldFormKey}, so {incomingFormKey} cannot take its place.")
    {
        HeldFormKey = heldFormKey;
    }

    public ChildSlotHeldByAnotherRecordException() : base("A child slot is held by another record.")
    {
    }

    public ChildSlotHeldByAnotherRecordException(string message) : base(message)
    {
    }

    public ChildSlotHeldByAnotherRecordException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
