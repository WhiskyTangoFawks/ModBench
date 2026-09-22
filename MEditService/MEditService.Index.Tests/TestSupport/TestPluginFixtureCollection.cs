using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests;

// xUnit collections are scoped per assembly, so the shared name needs its own registration here too.
[CollectionDefinition(TestPluginFixtureCollection.Name)]
public sealed class LocalTestPluginFixtureCollection : ICollectionFixture<TestPluginFixture>
{
}
