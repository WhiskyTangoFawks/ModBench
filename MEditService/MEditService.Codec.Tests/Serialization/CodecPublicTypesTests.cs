using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public class CodecPublicTypesTests
{
    // At the assembly level rather than the source level: the generated mixin must remain the only
    // public type this compilation produces outside MEditService's own namespaces.
    [Fact]
    public void CoreAssembly_HasNoOtherPublicTypeOutsideItsOwnNamespaces()
    {
        var alienPublicTypes = typeof(RecordTextCodec).Assembly.GetTypes()
            .Where(t => t.IsPublic && t.Namespace is not null && !t.Namespace.StartsWith("MEditService", StringComparison.Ordinal))
            .Select(t => t.FullName)
            .ToList();

        // Name confirmed empirically, not by naming-convention guesswork — a scratch project
        // seeded with MutagenJsonConverter.Instance.Serialize(mod, folder) and built with
        // -p:EmitCompilerGeneratedFiles=true actually emits this exact type, in this exact namespace.
        Assert.Equal(["Mutagen.Bethesda.Serialization.Newtonsoft.MutagenJsonConverterFallout4ModMixIns"], alienPublicTypes);
    }
}
