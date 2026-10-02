using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public class CodecPublicTypesTests
{
    // At the assembly level rather than the source level: the generated mixin must remain the only
    // public type this compilation produces outside MEditService's own namespaces.
    [Fact]
    public void TheCodecAssembly_HasNoOtherPublicTypeOutsideItsOwnNamespaces()
    {
        var alienPublicTypes = typeof(RecordTextCodec).Assembly.GetTypes()
            .Where(t => t.IsPublic && t.Namespace is not null && !t.Namespace.StartsWith("MEditService", StringComparison.Ordinal))
            .Select(t => t.FullName)
            .ToList();

        Assert.Equal(["Mutagen.Bethesda.Serialization.Newtonsoft.MutagenJsonConverterFallout4ModMixIns"], alienPublicTypes);
    }
}
