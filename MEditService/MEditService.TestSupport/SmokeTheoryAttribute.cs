using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary><see cref="SmokeFactAttribute"/> for a table.</summary>
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class SmokeTheoryAttribute : TheoryAttribute, ITraitAttribute
{
    public string Kind { get; } = KindDiscoverer.Smoke;
}
