namespace MEditService.Core.Plugins;

/// <summary>
/// Thrown by <see cref="ILoadOrderMirror.RequireScope"/> — the one place "no load order is held"
/// is thrown; consumers call it rather than re-writing their own null-check-and-throw.
///
/// <para>Derives from <see cref="InvalidOperationException"/> rather than replacing it as the write
/// endpoints' vocabulary for this failure — every existing <c>catch (InvalidOperationException)</c>
/// (including the ones that observe a different, unrelated mid-operation race inside
/// <c>RecordEditService</c>) keeps working unchanged, and this flows through
/// <c>WriteEndpointMapping.NoLoadOrder</c> with no signature change and no second 503 path.
/// </para>
/// </summary>
public sealed class NoLoadOrderException : InvalidOperationException
{
    private const string DefaultMessage = "No load order has been received.";

    public NoLoadOrderException() : base(DefaultMessage)
    {
    }

    public NoLoadOrderException(string message) : base(message)
    {
    }

    public NoLoadOrderException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
