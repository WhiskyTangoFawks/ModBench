namespace MEditService.Index;

public sealed class IndexNotReadyException : Exception
{
    internal IndexNotReadyException() : base("mEdit's index is not ready.")
    {
    }

    internal IndexNotReadyException(string message) : base(message)
    {
    }

    internal IndexNotReadyException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
