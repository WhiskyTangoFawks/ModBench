using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>Building a <see cref="RealSizeModlist"/>'s index takes minutes, so the gate of its own runs it.</summary>
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class RealSizeFactAttribute : FactAttribute, ITraitAttribute
{
    public string Kind { get; } = KindDiscoverer.RealSize;
}
