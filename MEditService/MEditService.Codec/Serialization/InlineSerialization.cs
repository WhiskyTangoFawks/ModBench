using System.Runtime.ExceptionServices;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen's generated serialization doors are async in signature only: every kernel read
/// and write is synchronous and the work dropoff these calls pass runs inline, so a door's task is
/// finished when it returns.</summary>
internal static class InlineSerialization
{
    /// <summary>The door's outcome as the calling thread's own, carrying the original exception
    /// rather than an aggregate of it. A task still running is that contract broken, and says so.
    /// </summary>
    internal static void Finished(Task door)
    {
        if (door.IsCompletedSuccessfully) return;
        if (door.Exception is { } failure)
            ExceptionDispatchInfo.Capture(failure.InnerException ?? failure).Throw();
        if (door.IsCanceled) throw new OperationCanceledException();

        throw new InvalidOperationException(
            "A Mutagen serialization door yielded. Its kernels are synchronous and its work runs "
            + "inline, so its task is finished by the time it returns.");
    }

    /// <summary>The same for a door that answers with a value.</summary>
    internal static T Finished<T>(Func<Task<T>> door) where T : class
    {
        T? answer = null;
        Finished(Capture(door(), value => answer = value));
        return answer ?? throw new InvalidOperationException("Expected the door to answer with a value.");
    }

    private static async Task Capture<T>(Task<T> door, Action<T> keep) => keep(await door.ConfigureAwait(false));
}
