namespace MEditService.LoadOrder;

public sealed class NoLoadOrderException : Exception
{
    public const string DefaultMessage = "No load order has been received.";

    public NoLoadOrderException() : base(DefaultMessage)
    {
    }

    internal NoLoadOrderException(string message) : base(message)
    {
    }

    internal NoLoadOrderException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
