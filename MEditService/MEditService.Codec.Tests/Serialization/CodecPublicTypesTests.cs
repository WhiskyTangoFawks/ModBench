using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public class CodecPublicTypesTests
{
    [Fact]
    public void TheCodecAssembly_ExposesNoForeignPublicTypeBeyondTheGeneratedMixins()
    {
        var alienPublicTypes = typeof(RecordTextCodec).Assembly.GetTypes()
            .Where(t => t.IsPublic && t.Namespace is not null && !t.Namespace.StartsWith("MEditService", StringComparison.Ordinal))
            .Where(t => !t.Name.StartsWith("MutagenJsonConverter", StringComparison.Ordinal) || !t.Name.EndsWith("ModMixIns", StringComparison.Ordinal))
            .Select(t => t.FullName)
            .ToList();

        Assert.Empty(alienPublicTypes);
    }
}
