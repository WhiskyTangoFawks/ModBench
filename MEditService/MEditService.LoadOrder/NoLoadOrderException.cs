namespace MEditService.LoadOrder;

public sealed class NoLoadOrderException : Exception
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
