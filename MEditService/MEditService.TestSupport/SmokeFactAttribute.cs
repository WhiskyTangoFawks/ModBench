using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>The test reads the user's game folder, so it runs only on a real machine.</summary>
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class SmokeFactAttribute : FactAttribute, ITraitAttribute
{
    public string Kind { get; } = KindDiscoverer.Smoke;
}
