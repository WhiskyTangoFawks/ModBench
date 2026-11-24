using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary><see cref="PosixFactAttribute"/> for a test with data rows.</summary>
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class PosixTheoryAttribute : TheoryAttribute, ITraitAttribute
{
    public string Kind { get; } = KindDiscoverer.Posix;
}
