namespace MEditService.Tests;

[CollectionDefinition(Name)]
public sealed class TestPluginFixtureCollection : ICollectionFixture<TestPluginFixture>
{
    public const string Name = "TestPluginFixture collection";
}
