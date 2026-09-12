using MEditService.Tests.TestSupport;

namespace MEditService.Tests;

// xUnit collections are scoped per assembly: this project's own registration for the shared
// TestPluginFixtureCollection.Name, alongside MEditService.TestSupport's own.
[CollectionDefinition(TestPluginFixtureCollection.Name)]
public sealed class LocalTestPluginFixtureCollection : ICollectionFixture<TestPluginFixture>
{
}
