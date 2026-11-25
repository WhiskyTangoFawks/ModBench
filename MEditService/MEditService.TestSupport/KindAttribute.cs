using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>A test's kind is one mark, the <c>Kind</c> trait, which a runner selects by. A test without the mark runs
/// at every branch.</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class KindAttribute(string kind) : Attribute, ITraitAttribute
{
    public string Kind { get; } = kind;
}
