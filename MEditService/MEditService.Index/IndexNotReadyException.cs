namespace MEditService.Index;

internal sealed class IndexNotReadyException : InvalidOperationException
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
