using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>The test needs a POSIX file system: a file mode that makes a read, write or delete fail, a FIFO, or two
/// names differing only in case. Windows leaves it out.</summary>
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class PosixFactAttribute : FactAttribute, ITraitAttribute
{
    public string Kind { get; } = KindDiscoverer.Posix;
}
