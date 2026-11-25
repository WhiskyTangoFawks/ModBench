using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>The test runs on a <see cref="RealSizeModlist"/>, which only a real machine holds.</summary>
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class RealSizeFactAttribute : FactAttribute, ITraitAttribute
{
    public string Kind { get; } = KindDiscoverer.RealSize;
}
