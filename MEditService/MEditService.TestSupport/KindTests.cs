using Xunit.Sdk;

namespace MEditService.TestSupport;

public sealed class KindTests
{
    [Theory]
    [InlineData(typeof(RealSizeFactAttribute), "RealSize")]
    [InlineData(typeof(SmokeFactAttribute), "Smoke")]
    [InlineData(typeof(SmokeTheoryAttribute), "Smoke")]
    [InlineData(typeof(PosixFactAttribute), "Posix")]
    [InlineData(typeof(PosixTheoryAttribute), "Posix")]
    public void AMark_NamesItsKind_ForTheDiscovererThatMakesItTheKindTrait(Type mark, string kind)
    {
        var instance = Assert.IsAssignableFrom<ITraitAttribute>(Activator.CreateInstance(mark));
        var discoverer = mark.GetCustomAttributesData().Single(data => data.AttributeType == typeof(TraitDiscovererAttribute));

        Assert.Equal(kind, mark.GetProperty("Kind").Require().GetValue(instance));
        Assert.Equal([KindDiscoverer.TypeName, KindDiscoverer.AssemblyName], discoverer.ConstructorArguments.Select(argument => argument.Value));
    }
}
