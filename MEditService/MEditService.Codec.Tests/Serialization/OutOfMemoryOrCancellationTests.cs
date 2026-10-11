using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public sealed class OutOfMemoryOrCancellationTests
{
    [Fact]
    public void AnOutOfMemoryWrappedTwice_IsFound()
    {
        var outOfMemory = Activator.CreateInstance<OutOfMemoryException>();

        Assert.Same(outOfMemory, OutOfMemoryOrCancellation.In(new InvalidOperationException("outer", new InvalidDataException("inner", outOfMemory))));
    }

    [Fact]
    public void AWrappedCancellation_IsFound()
    {
        var cancelled = new OperationCanceledException();

        Assert.Same(cancelled, OutOfMemoryOrCancellation.In(new InvalidOperationException("outer", cancelled)));
    }

    [Fact]
    public void AFailureOfTheFileItself_IsNot() =>
        Assert.Null(OutOfMemoryOrCancellation.In(new InvalidOperationException("outer", new InvalidDataException("a bad subrecord"))));
}
