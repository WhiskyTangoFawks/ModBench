namespace MEditService.Index;

public sealed class IndexNotReadyException : Exception
{
    internal IndexNotReadyException()
    {
    }

    internal IndexNotReadyException(string message) : base(message)
    {
    }

    internal IndexNotReadyException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
