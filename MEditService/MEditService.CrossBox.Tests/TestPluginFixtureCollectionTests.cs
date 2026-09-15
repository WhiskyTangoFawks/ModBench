namespace MEditService.Tests;

file static class SharedFixtureCapture
{
    private static TestPluginFixture? _first;

    public static void AssertSharedWithOtherConsumer(TestPluginFixture fixture)
    {
        var first = Interlocked.CompareExchange(ref _first, fixture, null);
        if (first is not null) Assert.Same(first, fixture);
    }
}

[Collection(TestPluginFixtureCollection.Name)]
public class TestPluginFixtureCollectionConsumerATests(TestPluginFixture fixture)
{
    [Fact]
    public void SharesInstanceWithOtherConsumer() =>
        SharedFixtureCapture.AssertSharedWithOtherConsumer(fixture);
}

[Collection(TestPluginFixtureCollection.Name)]
public class TestPluginFixtureCollectionConsumerBTests(TestPluginFixture fixture)
{
    [Fact]
    public void SharesInstanceWithOtherConsumer() =>
        SharedFixtureCapture.AssertSharedWithOtherConsumer(fixture);
}
