using MEditService.RecordIndex.Tests.TestSupport;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class SharedIndexRestoreTests
{
    [Fact]
    public void ARestoreThatFails_FailsEveryTestAfterItNamingItself()
    {
        using var shared = new RealSizeIndex(() => throw new InvalidOperationException("The modlist was generated."));
        Assert.Throws<TimeoutException>(() => shared.Restore(() => { }, () => false, TimeSpan.Zero));

        var after = Assert.Throws<InvalidOperationException>(() => shared.Index);

        Assert.Contains("An earlier test left the shared index changed", after.Message, StringComparison.Ordinal);
    }
}
