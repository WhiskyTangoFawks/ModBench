using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>A test's kind is one mark, the <c>Kind</c> trait, which a runner selects by. A test without the trait runs
/// at every branch.</summary>
public sealed class KindDiscoverer : ITraitDiscoverer
{
    public const string TypeName = "MEditService.TestSupport.KindDiscoverer";
    public const string AssemblyName = "MEditService.TestSupport";

    public const string RealSize = "RealSize";
    public const string Smoke = "Smoke";
    public const string Posix = "Posix";
    public const string Measured = "Measured";

    public IEnumerable<KeyValuePair<string, string>> GetTraits(IAttributeInfo traitAttribute) =>
        [KeyValuePair.Create("Kind", traitAttribute.GetNamedArgument<string>("Kind"))];
}
