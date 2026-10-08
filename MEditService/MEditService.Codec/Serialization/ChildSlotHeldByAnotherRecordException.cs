namespace MEditService.Codec.Serialization;

/// <summary>A single-valued child slot, a worldspace's persistent cell, holds a record other than the
/// one that would take it.</summary>
public sealed class ChildSlotHeldByAnotherRecordException : InvalidOperationException
{
    internal ChildSlotHeldByAnotherRecordException(string parentType, string slotName, string heldFormKey, string incomingFormKey)
        : base($"{parentType}.{slotName} already holds {heldFormKey}, so {incomingFormKey} cannot take its place.")
    {
    }

    internal ChildSlotHeldByAnotherRecordException() : base("A child slot is held by another record.")
    {
    }

    internal ChildSlotHeldByAnotherRecordException(string message) : base(message)
    {
    }

    internal ChildSlotHeldByAnotherRecordException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
