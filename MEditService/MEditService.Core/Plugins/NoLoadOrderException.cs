namespace MEditService.Core.Plugins;

/// <summary>Derives from <see cref="InvalidOperationException"/> rather than replacing it as the
/// write endpoints' vocabulary for this failure: every existing catch of that keeps working, and
/// this needs no second 503 path.</summary>
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
