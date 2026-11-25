using Xunit.Sdk;

namespace MEditService.TestSupport;

public sealed class KindAttributeTests
{
    [Fact]
    public void AKind_IsTheKindTraitOfItsName()
    {
        var mark = typeof(Marked).GetCustomAttributesData().Single();

        Assert.Equal([KeyValuePair.Create("Kind", "Tool")], new KindDiscoverer().GetTraits(Reflector.Wrap(mark)));
    }

    [Kind(Kinds.Tool)]
    private static class Marked;
}
