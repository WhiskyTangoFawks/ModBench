using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class StarfieldLeafSchemaTests
{
    private static FieldMetadata Member(string table, string column, string member) =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield)[table].RecordColumns.Single(c => c.Name == column)
            .Field.Fields.Require().Single(f => f.Name == member);

    [Fact]
    public void ADouble_IsAFloatLeaf()
    {
        Assert.Equal("float", Member("pndt", "OrbitedData", "GravityWell").Type);
    }

    [Fact]
    public void AGuid_IsAStringLeaf_AsTheCodecSpellsIt()
    {
        var markers = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield)["sech"]
            .RecordColumns.Single(c => c.Name == "Markers").Field;

        Assert.Equal("string", markers.ElementType.Require().Fields.Require().Single(f => f.Name == "ECTE").Type);
    }
}
