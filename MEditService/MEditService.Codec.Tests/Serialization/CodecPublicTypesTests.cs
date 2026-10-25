using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public class CodecPublicTypesTests
{
    [Fact]
    public void TheCodecAssembly_ExposesOnlyMEditServiceTypes()
    {
        var alienPublicTypes = typeof(RecordTextCodec).Assembly.GetTypes()
            .Where(t => t.IsPublic && t.Namespace is not null && !t.Namespace.StartsWith("MEditService", StringComparison.Ordinal))
            .Select(t => t.FullName);

        Assert.Empty(alienPublicTypes);
    }
}
