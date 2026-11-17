using System.Reflection;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public class MutagenBuildTests
{
    private static readonly Assembly Mutagen = typeof(IModGetter).Assembly;

    [Fact]
    public void TheMutagenVersion_CarriesTheCommit_AndIsNotTheAssemblyVersion()
    {
        Assert.Contains('+', SchemaReflector.MutagenVersion);
        Assert.NotEqual(Mutagen.GetName().Version?.ToString(), SchemaReflector.MutagenVersion);
    }
}
