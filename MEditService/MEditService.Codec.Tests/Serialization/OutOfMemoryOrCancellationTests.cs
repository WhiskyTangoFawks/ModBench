using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public sealed class OutOfMemoryOrCancellationTests
{
    private static readonly OutOfMemoryException OutOfMemory = Activator.CreateInstance<OutOfMemoryException>();
    private static readonly OperationCanceledException Cancelled = new();

    public static TheoryData<string, Exception, Exception?> Thrown => new()
    {
        { "an out-of-memory wrapped twice", new InvalidOperationException("outer", new InvalidDataException("inner", OutOfMemory)), OutOfMemory },
        { "a wrapped cancellation", new InvalidOperationException("outer", Cancelled), Cancelled },
        { "a failure of the file itself", new InvalidOperationException("outer", new InvalidDataException("a bad subrecord")), null },
    };

    [Theory]
    [MemberData(nameof(Thrown))]
    public void TheOutOfMemoryOrCancellationAThrowWraps_IsFound(string _, Exception thrown, Exception? found) =>
        Assert.Same(found, OutOfMemoryOrCancellation.In(thrown));
}
