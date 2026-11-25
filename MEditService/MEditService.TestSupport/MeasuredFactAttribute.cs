using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>The test's result is a measured time or memory against a limit, and a virtual machine's speed and
/// memory move it. A virtual machine leaves it out.</summary>
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class MeasuredFactAttribute : FactAttribute, ITraitAttribute
{
    public string Kind { get; } = KindDiscoverer.Measured;
}
