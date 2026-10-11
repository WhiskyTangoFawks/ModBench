namespace MEditService.Codec.Serialization;

/// <summary>Running out of memory or being cancelled stops a read without being the file's answer, and
/// Mutagen can wrap either in exceptions of its own.</summary>
public static class OutOfMemoryOrCancellation
{
    /// <summary>The out-of-memory or cancellation <paramref name="ex"/> is or wraps, or null.</summary>
    public static Exception? In(Exception? ex) =>
        ex is null or OutOfMemoryException or OperationCanceledException ? ex : In(ex.InnerException);
}
