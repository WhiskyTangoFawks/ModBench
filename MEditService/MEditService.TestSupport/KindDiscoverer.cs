using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.TestSupport;

public sealed class KindDiscoverer : ITraitDiscoverer
{
    public const string TypeName = "MEditService.TestSupport.KindDiscoverer";
    public const string AssemblyName = "MEditService.TestSupport";

    public IEnumerable<KeyValuePair<string, string>> GetTraits(IAttributeInfo traitAttribute) =>
        [KeyValuePair.Create(nameof(KindAttribute.Kind), traitAttribute.GetNamedArgument<string>(nameof(KindAttribute.Kind)))];
}
